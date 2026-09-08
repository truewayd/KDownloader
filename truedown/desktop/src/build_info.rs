use serde::Deserialize;

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    product: String,
    protocol_version: u32,
    product_version: String,
    version: String,
    build_number: String,
    commit: String,
}

impl Info {
    pub fn verify_update() -> Result<(), String> {
        let bundled: Self = serde_json::from_str(include_str!("../../dist/desktop-build.json"))
            .map_err(|_| "Invalid compiled desktop build identity")?;
        if std::env::var("TRUEDOWN_UPDATE_EXPECTED_BUILD").as_deref() != Ok(&bundled.build_number) {
            return Err("The updated desktop build does not match its release manifest".into());
        }
        Ok(())
    }
    pub fn verify(&self) -> Result<(), String> {
        let bundled: Self = serde_json::from_str(include_str!("../../dist/desktop-build.json"))
            .map_err(|_| "Invalid compiled desktop build identity")?;
        if self != &bundled {
            return Err(
                "The TrueDown shell, core and CLI must come from the same release package".into(),
            );
        }
        Ok(())
    }
}
