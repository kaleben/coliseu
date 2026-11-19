//! HTTPS pelo Tailscale (docs/NOTIFY_SPEC.md): certificado Let's Encrypt
//! emitido pelo `tailscale cert` para o nome da máquina na tailnet.
//!
//! Arquivos em ~/.local/share/coliseu/tls/ (a chave fica com permissão 600).
//! O `tailscale cert` só busca um novo quando o atual está perto de vencer,
//! então chamá-lo na abertura e uma vez por dia basta para renovar.

use std::path::PathBuf;

pub struct CertFiles {
    pub cert: PathBuf,
    pub key: PathBuf,
}

fn dir() -> PathBuf {
    crate::accounts::base().join("tls")
}

/// `tailscale status --json` com limite de 3 s (um tailscaled travado não pode
/// travar a abertura do app nem as configurações).
fn status_json() -> Option<serde_json::Value> {
    use std::io::Read;
    let mut child = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = stdout.read_to_end(&mut b);
        b
    });
    let t0 = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() < std::time::Duration::from_secs(3) => std::thread::sleep(std::time::Duration::from_millis(20)),
            // Estourou o tempo ou erro: encerra o processo (a thread de leitura termina junto).
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    serde_json::from_slice(&reader.join().ok()?).ok()
}

/// IPv4 desta máquina no Tailscale.
pub fn ipv4() -> Option<String> {
    let v = status_json()?;
    v["Self"]["TailscaleIPs"].as_array()?.iter().filter_map(|x| x.as_str()).find(|ip| ip.starts_with("100.")).map(str::to_owned)
}

/// Nome da máquina na tailnet (ex.: "pc.tailXXXX.ts.net"), se o HTTPS estiver liberado nela.
pub fn dns_name() -> Option<String> {
    let v = status_json()?;
    let name = v["Self"]["DNSName"].as_str()?.trim_end_matches('.').to_owned();
    let allowed = v["CertDomains"].as_array()?.iter().any(|d| d.as_str() == Some(name.as_str()));
    allowed.then_some(name)
}

/// Garante um certificado válido para `name` (emite/renova se preciso).
pub fn ensure(name: &str) -> Result<CertFiles, String> {
    use std::os::unix::fs::PermissionsExt;
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
    let files = CertFiles { cert: d.join("cert.pem"), key: d.join("key.pem") };
    let out = std::process::Command::new("tailscale")
        .arg("cert")
        .arg("--cert-file")
        .arg(&files.cert)
        .arg("--key-file")
        .arg(&files.key)
        .arg(name)
        .output()
        .map_err(|e| format!("tailscale: {e}"))?;
    let _ = std::fs::set_permissions(&files.key, std::fs::Permissions::from_mode(0o600));
    if !out.status.success() {
        // Falhou a renovação mas há um certificado de antes: segue com ele.
        if files.cert.exists() && files.key.exists() {
            eprintln!("[coliseu] tailscale cert: {}", String::from_utf8_lossy(&out.stderr).trim());
            return Ok(files);
        }
        return Err(format!("tailscale cert falhou: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(files)
}
