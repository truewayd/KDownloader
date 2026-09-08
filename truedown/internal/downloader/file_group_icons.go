package downloader

type FileGroupIcon struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// IDs refer only to the reviewed, bundled icon sprite.
var fileGroupIcons = []FileGroupIcon{
	{"folder", "\u6587\u4ef6\u5939"}, {"folder-open", "\u6253\u5f00\u6587\u4ef6\u5939"},
	{"image", "\u56fe\u7247"}, {"video", "\u89c6\u9891"}, {"music", "\u97f3\u4e50"},
	{"archive", "\u538b\u7f29\u5305"}, {"app-window", "\u5e94\u7528"}, {"logs", "\u6587\u6863"},
	{"file", "\u6587\u4ef6"}, {"settings", "\u5de5\u7a0b"}, {"code", "\u4ee3\u7801"},
	{"star", "\u661f\u6807"}, {"heart", "\u6536\u85cf"}, {"bookmark", "\u4e66\u7b7e"},
	{"book-open", "\u4e66\u7c4d"}, {"palette", "\u8bbe\u8ba1"}, {"camera", "\u76f8\u673a"},
	{"gamepad-2", "\u6e38\u620f"}, {"briefcase", "\u5de5\u4f5c"}, {"graduation-cap", "\u5b66\u4e60"},
	{"cloud", "\u4e91\u7aef"}, {"database", "\u6570\u636e\u5e93"}, {"server", "\u670d\u52a1\u5668"},
	{"download", "\u4e0b\u8f7d"}, {"clock", "\u65f6\u949f"}, {"check", "\u5b8c\u6210"},
}

func validGroupIcon(id string) bool {
	if id == "" {
		return true
	}
	for _, icon := range fileGroupIcons {
		if icon.ID == id {
			return true
		}
	}
	return false
}
