use urlpattern::{UrlPattern, UrlPatternInit, UrlPatternMatchInput};

#[test]
fn urlpattern_preserves_identifier_and_origin_boundaries() {
    // U+037A is ID_Start but not XID_Start; URLPattern requires ID properties.
    for name in [
        "id",
        "_id",
        "$id",
        "\u{037a}",
        "\u{4e2d}\u{6587}",
        "a\u{301}",
        "a\u{200c}",
        "a\u{200d}",
    ] {
        let pattern = <UrlPattern>::parse(
            UrlPatternInit {
                protocol: Some("https".into()),
                hostname: Some("example.com".into()),
                pathname: Some(format!("/tasks/:{name}")),
                ..Default::default()
            },
            Default::default(),
        )
        .unwrap();
        let result = pattern
            .exec(UrlPatternMatchInput::Url(
                "https://example.com/tasks/123".parse().unwrap(),
            ))
            .unwrap()
            .unwrap();
        assert_eq!(
            result.pathname.groups.get(name).unwrap().as_deref(),
            Some("123")
        );
        for url in [
            "http://example.com/tasks/123",
            "https://example.com.evil/tasks/123",
            "https://example.com/tasks/123/456",
        ] {
            assert!(!pattern
                .test(UrlPatternMatchInput::Url(url.parse().unwrap()))
                .unwrap());
        }
    }
    for name in ["1id", "\u{301}", "\u{200c}", "\u{1f600}"] {
        assert!(<UrlPattern>::parse(
            UrlPatternInit {
                pathname: Some(format!("/:{name}")),
                ..Default::default()
            },
            Default::default()
        )
        .is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn glib_string_iteration_survives_optimized_ffi_writes() {
    use glib::variant::ToVariant;
    let expected = ["first", "", "\u{4e2d}\u{6587}", "last"];
    let variant = expected.to_variant();
    assert_eq!(
        variant.array_iter_str().unwrap().collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        expected.into_iter().rev().collect::<Vec<_>>()
    );
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.nth(1), Some("\u{4e2d}\u{6587}"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}
