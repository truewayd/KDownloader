fn main() {
    println!("cargo:rerun-if-changed=../dist/desktop-build.json");
    println!("cargo:rerun-if-changed=windows-app.manifest");
    let windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Cannot prepare native application resources");
}
