//! Notificações nativas (D-Bus / GNOME). Clicar abre o Coliseu no terminal certo.

use notify_rust::{Hint, Notification, Timeout};
use tauri::{AppHandle, Emitter, Manager};

pub fn send(app: AppHandle, title: String, body: String, term_id: Option<String>, sound: bool) {
    std::thread::spawn(move || {
        let mut n = Notification::new();
        n.appname("Coliseu")
            .summary(&title)
            .body(&body)
            .icon("utilities-terminal")
            .action("default", "Abrir")
            .timeout(Timeout::Milliseconds(10_000));
        if sound {
            n.hint(Hint::SoundName("message-new-instant".into()));
        } else {
            n.hint(Hint::SuppressSound(true));
        }
        let handle = match n.show() {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[coliseu] falha ao notificar: {e}");
                return;
            }
        };
        handle.wait_for_action(|action| {
            if action != "default" {
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                // GNOME barra o "roubo de foco" de quem está em segundo plano e mostra
                // outra notificação ("Coliseu está pronto"). Ativar pela via de
                // pager (_NET_ACTIVE_WINDOW, como o xdotool faz) ele aceita.
                if !activate_x11() {
                    let _ = w.set_focus();
                }
            }
            if let Some(id) = &term_id {
                let _ = app.emit("focus-term", id.clone());
            }
        });
    });
}

/// Traz a janela do Coliseu para a frente no X11 (xdotool). false se não deu.
fn activate_x11() -> bool {
    use std::process::Command;
    if std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t != "x11") {
        return false;
    }
    let pid = std::process::id().to_string();
    let Ok(out) = Command::new("xdotool").args(["search", "--pid", &pid]).output() else {
        return false; // sem xdotool
    };
    // O processo tem uma janela "líder" invisível do GTK; a de verdade é a NORMAL.
    for id in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        let normal = Command::new("xprop")
            .args(["-id", id, "_NET_WM_WINDOW_TYPE"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("_NET_WM_WINDOW_TYPE_NORMAL"));
        if normal {
            return Command::new("xdotool").args(["windowactivate", id]).status().is_ok_and(|s| s.success());
        }
    }
    false
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore] // mostra uma notificação real: `cargo test --lib notify_live -- --ignored`
    fn notify_live() {
        notify_rust::Notification::new()
            .appname("Coliseu")
            .summary("Coliseu: teste")
            .body("Se você está vendo isto, as notificações funcionam.")
            .icon("utilities-terminal")
            .show()
            .expect("falhou ao notificar");
    }
}
