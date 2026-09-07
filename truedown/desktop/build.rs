fn main() {
    println!("cargo:rerun-if-changed=../dist/desktop-build.json");
    tauri_build::build()
}
