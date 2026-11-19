//! Ponte PTY: cada painel da UI é um cliente `tmux attach` num PTY real.
//!
//! Vários clientes podem olhar o mesmo terminal (janela desktop + celular):
//! cada um tem uma chave própria — `<termId>` no desktop, `<termId>@<conexão>`
//! no acesso remoto.

use crate::tmux;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{collections::HashMap, io::{Read, Write}, sync::Arc};

/// Destino da saída do terminal. Retorna `false` quando o destino fechou.
pub type Sink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;

pub struct Client {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Incrementa a cada attach para ignorar EOF de clientes antigos.
    generation: u64,
}

#[derive(Default, Clone)]
pub struct Clients(Arc<Mutex<HashMap<String, Client>>>, Arc<Mutex<u64>>);

impl Clients {
    /// Anexa o terminal `term_id` (sessão tmux já existente) como o cliente `key`.
    /// `on_exit(sessão_acabou)` é chamado quando o cliente termina.
    pub fn attach(
        &self,
        key: &str,
        term_id: &str,
        cols: u16,
        rows: u16,
        mut out: Sink,
        on_exit: impl FnOnce(bool) + Send + 'static,
    ) -> anyhow::Result<()> {
        self.detach(key);
        let session = tmux::session_name(term_id);

        // Pré-carrega o histórico no scrollback do xterm.js e empurra a tela
        // para cima, para o redraw do tmux não apagar as últimas linhas.
        let hist = tmux::capture_history(&session);
        if !hist.trim().is_empty() {
            let mut buf = hist.trim_end_matches('\n').replace('\n', "\r\n");
            buf.push_str("\r\n");
            buf.push_str(&"\r\n".repeat(rows as usize));
            out(buf.into_bytes());
        }

        let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        let mut cb = CommandBuilder::new("tmux");
        cb.env_clear();
        for (k, v) in tmux::clean_env() {
            cb.env(k, v);
        }
        cb.env("TERM", "xterm-256color");
        cb.env("COLORTERM", "truecolor");
        cb.args(["-L", &tmux::socket(), "-f"]);
        cb.arg(tmux::conf_path());
        cb.args(["attach-session", "-t", &format!("={session}")]);
        let child = pair.slave.spawn_command(cb)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let generation = {
            let mut g = self.1.lock();
            *g += 1;
            *g
        };
        self.0.lock().insert(key.to_owned(), Client { writer, master: pair.master, child, generation });

        let clients = self.clone();
        let id = key.to_owned();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if !out(buf[..n].to_vec()) {
                            break;
                        }
                    }
                }
            }
            // Só reporta se este ainda é o cliente atual (não foi substituído).
            let mut map = clients.0.lock();
            let current = map.get(&id).map(|c| c.generation) == Some(generation);
            if current {
                if let Some(mut c) = map.remove(&id) {
                    let _ = c.child.wait();
                }
            }
            drop(map);
            if current {
                on_exit(!tmux::has_session(&session));
            }
        });
        Ok(())
    }

    pub fn write(&self, key: &str, data: &[u8]) {
        if let Some(c) = self.0.lock().get_mut(key) {
            let _ = c.writer.write_all(data);
            let _ = c.writer.flush();
        }
    }

    pub fn resize(&self, key: &str, cols: u16, rows: u16) {
        if let Some(c) = self.0.lock().get(key) {
            let _ = c.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    /// Fecha só o cliente; a sessão tmux continua viva.
    pub fn detach(&self, key: &str) {
        if let Some(mut c) = self.0.lock().remove(key) {
            let _ = c.child.kill();
            let _ = c.child.wait();
        }
    }

    /// Fecha todos os clientes de um terminal (desktop e remotos).
    pub fn detach_all_of(&self, term_id: &str) {
        let prefix = format!("{term_id}@");
        let keys: Vec<String> = self.0.lock().keys().filter(|k| *k == term_id || k.starts_with(&prefix)).cloned().collect();
        for k in keys {
            self.detach(&k);
        }
    }

    /// Fecha todos os clientes de uma conexão remota.
    pub fn detach_conn(&self, conn: &str) {
        let suffix = format!("@{conn}");
        let keys: Vec<String> = self.0.lock().keys().filter(|k| k.ends_with(&suffix)).cloned().collect();
        for k in keys {
            self.detach(&k);
        }
    }
}
