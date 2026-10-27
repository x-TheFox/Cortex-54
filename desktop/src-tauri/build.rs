use sha2::{Digest, Sha256};
use std::path::Path;

/// Protection (ADR-089): embed the sha256 of the bundled brain (dist/cortexd/cortexd.mjs) so the shell refuses to run
/// a modified copy. A dev build without the bundle embeds an empty hash, which skips the check.
fn main() {
    let bundle = Path::new("../../dist/cortexd/cortexd.mjs");
    println!("cargo:rerun-if-changed=../../dist/cortexd/cortexd.mjs");
    println!("cargo:rerun-if-env-changed=SAVANT_SKIP_INTEGRITY");
    let hash = if std::env::var("SAVANT_SKIP_INTEGRITY").is_ok() {
        String::new()
    } else {
        std::fs::read(bundle)
            .map(|b| Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect::<String>())
            .unwrap_or_default()
    };
    println!("cargo:rustc-env=CORTEXD_SHA256={hash}");
    tauri_build::build()
}
