// Package web embeds the dashboard once for all service entry points.
package web

import "embed"

// Assets contains only web resources, never Go sources.
//
//go:embed *.html *.css *.js *.svg
var Assets embed.FS
