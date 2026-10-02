/* Downloaded bytes stay in blob-backed media elements; controls have no native privileges. */
window.TrueDownPreviewPlayer = (() => {
  const formatTime = value => {
    const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const node = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const icon = name => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const use = document.createElementNS(svg.namespaceURI, "use"); use.setAttribute("href", `/icons.svg#icon-${name}`); svg.append(use);
    return svg;
  };
  function create(media, name, report) {
    const isVideo = media.tagName === "VIDEO", events = new AbortController();
    const on = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal });
    let disposed = false, seeking = false, lastVolume = 1;
    const root = node("section", `preview-player ${isVideo ? "preview-video" : "preview-audio"}`);
    root.tabIndex = 0; root.setAttribute("aria-label", isVideo ? "视频播放器" : "音频播放器");
    const visual = node("div", "player-visual");
    media.controls = false; media.preload = "metadata"; media.playsInline = true;
    media.disablePictureInPicture = true; media.disableRemotePlayback = true;
    if (isVideo) visual.append(media);
    else {
      media.hidden = true;
      const artwork = node("div", "player-artwork"); artwork.append(icon("music"));
      const title = node("div", "player-filename kd-selectable", name);
      visual.append(artwork, title, node("p", "player-subtitle", "音频预览"), media);
    }
    const controls = node("div", "player-controls");
    const timeline = node("div", "player-timeline"), track = node("div", "player-track");
    const buffer = node("progress", "player-buffer"); buffer.max = 100; buffer.value = 0; buffer.setAttribute("aria-hidden", "true");
    const seek = node("input", "player-range player-seek"); seek.type = "range"; seek.min = "0"; seek.max = "100"; seek.step = "0.1"; seek.value = "0";
    seek.setAttribute("aria-label", "播放进度"); seek.disabled = true;
    const time = node("span", "player-time", "0:00 / 0:00");
    track.append(buffer, seek); timeline.append(track, time);
    const row = node("div", "player-actions"), transport = node("div", "player-transport"), options = node("div", "player-options");
    const button = (label, iconName, className = "") => {
      const element = node("button", `kd-icon-button ${className}`); element.type = "button";
      element.setAttribute("aria-label", label); element.title = label; element.append(icon(iconName)); return element;
    };
    const updateButton = (button, label, iconName) => {
      button.setAttribute("aria-label", label); button.title = label;
      button.querySelector("use").setAttribute("href", `/icons.svg#icon-${iconName}`);
    };
    const back = button("后退 10 秒", "reset", "player-skip"), forward = button("前进 10 秒", "retry", "player-skip");
    back.append(node("span", "player-skip-label", "10")); forward.append(node("span", "player-skip-label", "10"));
    const play = button("播放", "play", "player-play"); play.disabled = true;
    transport.append(back, play, forward);
    const mute = button("静音", "volume"), volume = node("input", "player-range player-volume");
    volume.type = "range"; volume.min = "0"; volume.max = "1"; volume.step = "0.05"; volume.value = "1"; volume.setAttribute("aria-label", "音量");
    const volumeGroup = node("div", "player-volume-group"); volumeGroup.append(mute, volume);
    const rate = node("button", "kd-button secondary player-rate", "1×"); rate.type = "button"; rate.setAttribute("aria-label", "播放速度：1 倍"); rate.title = "切换播放速度";
    const fullscreen = button("全屏", "fullscreen"); fullscreen.hidden = !isVideo || !document.fullscreenEnabled;
    options.append(volumeGroup, rate, fullscreen); row.append(transport, options);
    const state = node("span", "player-state", "正在加载媒体…"); state.setAttribute("role", "status");
    controls.append(timeline, row, state); root.append(visual, controls);
    const duration = () => Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    const updateTime = () => {
      const end = duration(); seek.disabled = !end || Boolean(media.error); back.disabled = forward.disabled = seek.disabled;
      seek.max = String(end || 100);
      if (!seeking) seek.value = String(media.currentTime || 0);
      const position = Number(seek.value);
      seek.style.setProperty("--player-progress", `${end ? position / end * 100 : 0}%`);
      seek.setAttribute("aria-valuetext", `${formatTime(position)}，共 ${formatTime(end)}`);
      time.textContent = `${formatTime(position)} / ${formatTime(end)}`;
      let buffered = 0;
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= position && media.buffered.end(i) >= position) buffered = media.buffered.end(i);
      }
      buffer.value = end ? Math.min(100, buffered / end * 100) : 0;
    };
    const syncPlayback = () => {
      updateButton(play, media.ended ? "重新播放" : media.paused ? "播放" : "暂停", media.paused ? "play" : "pause");
      state.textContent = media.ended ? "播放完毕" : media.paused ? "已暂停" : "正在播放";
      root.dataset.playing = String(!media.paused && !media.ended);
    };
    const toggle = async () => {
      if (disposed || play.disabled) return;
      if (!media.paused) { media.pause(); return; }
      try { if (media.ended) media.currentTime = 0; await media.play(); }
      catch { if (!disposed) { state.textContent = "播放未能开始，请重试"; report("无法开始播放，可重试或选择打开文件。"); } }
    };
    const jump = seconds => { if (duration() && !media.error) media.currentTime = Math.max(0, Math.min(duration(), media.currentTime + seconds)); };
    const toggleMute = () => {
      const silent = media.muted || media.volume === 0;
      if (silent && media.volume === 0) media.volume = lastVolume || 1;
      media.muted = !silent;
    };
    const full = async () => {
      if (fullscreen.hidden || disposed) return;
      try { if (document.fullscreenElement === root) await document.exitFullscreen(); else await root.requestFullscreen(); }
      catch { if (!disposed) report("当前窗口无法进入全屏，请使用窗口最大化。"); }
    };
    on(play, "click", toggle); on(back, "click", () => jump(-10)); on(forward, "click", () => jump(10));
    if (isVideo) { on(media, "click", toggle); on(media, "dblclick", full); }
    on(seek, "input", () => { seeking = true; updateTime(); });
    on(seek, "change", () => { if (duration()) media.currentTime = Math.max(0, Math.min(duration(), Number(seek.value))); seeking = false; updateTime(); });
    on(seek, "blur", () => { seeking = false; updateTime(); });
    on(mute, "click", toggleMute);
    on(volume, "input", () => { media.volume = Number(volume.value); media.muted = media.volume === 0; });
    on(media, "volumechange", () => {
      const silent = media.muted || media.volume === 0;
      if (media.volume > 0) lastVolume = media.volume;
      volume.value = String(silent ? 0 : media.volume); volume.style.setProperty("--player-progress", `${Number(volume.value) * 100}%`);
      volume.setAttribute("aria-valuetext", `${Math.round(Number(volume.value) * 100)}%`);
      updateButton(mute, silent ? "取消静音" : "静音", silent ? "volume-off" : "volume");
    });
    volume.style.setProperty("--player-progress", "100%");
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    on(rate, "click", () => { media.playbackRate = speeds[(speeds.indexOf(media.playbackRate) + 1) % speeds.length]; });
    on(media, "ratechange", () => { rate.textContent = `${media.playbackRate}×`; rate.setAttribute("aria-label", `播放速度：${media.playbackRate} 倍`); });
    on(fullscreen, "click", full);
    on(document, "fullscreenchange", () => updateButton(fullscreen, document.fullscreenElement === root ? "退出全屏" : "全屏", document.fullscreenElement === root ? "fullscreen-exit" : "fullscreen"));
    on(root, "keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest("button, input, select, textarea, a, [contenteditable]")) return;
      const key = event.key.toLowerCase();
      if ([" ", "k", "m", "f", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault();
        if (key === " " || key === "k") void toggle();
        else if (key === "m") toggleMute(); else if (key === "f") void full(); else jump(key === "arrowleft" ? -10 : 10);
      }
    });
    root.setAttribute("aria-keyshortcuts", "Space K M F ArrowLeft ArrowRight");
    for (const event of ["timeupdate", "durationchange", "progress", "loadedmetadata", "seeked"]) on(media, event, updateTime);
    for (const event of ["play", "pause", "ended", "playing"]) on(media, event, syncPlayback);
    on(media, "canplay", () => { play.disabled = false; syncPlayback(); });
    on(media, "waiting", () => { state.textContent = "正在缓冲…"; });
    on(media, "seeking", () => { state.textContent = "正在定位…"; });
    on(media, "seeked", syncPlayback);
    on(media, "error", () => { play.disabled = seek.disabled = back.disabled = forward.disabled = true; state.textContent = "无法解码，可选择打开文件"; });
    updateTime();
    return { element: root, dispose() {
      disposed = true; events.abort();
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    } };
  }
  return { create };
})();
