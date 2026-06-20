扩展项目支持的网站范围，现在支持https://pawchive.st/这个网站。其中：
1.暂时仅支持对下载历史的读取和保存，结构类似于kemono.party/kemono.cr；
2.这个网站更多使用静态加载，需要切换注入模式；
3.用户页，例如https://pawchive.st/patreon/user/12793：
    a.在此处加入page fetch页面：
    <div class="user-header__info">
      <h1 id="user-header__info-top" class="user-header__name">
        <a class="user-header__profile" target="_blank" rel="noreferrer" href="https://www.patreon.com/user?u=12793" itemprop="url">
          <span class="user-header__profile-image">
            <img src="/static/patreon.svg">
          </span>
          <span itemprop="name">NBA</span>
        </a>
      </h1>

      <div class="user-header__actions">
        <a class="user-header__upload" href="/posts/upload?service=patreon&amp;user=12793">
          <span>Upload file</span>
        </a>
      <button class="user-header__favourite user-header__favourite--unfav" type="button">
    <span class="user-header__fav-icon">★</span>
    <span class="user-header__fav-text">Unfavorite</span>
    >>插入到这里
  </button></div>
    </div>
    b.这是创作者页每一个帖子的格式
    <div class="card-list card-list--legacy ">
    <div class="card-list__layout">
    </div>
    <div class="card-list__items" style="--card-size: 180px;">
  <article class="post-card post-card--preview" data-id="161545280" data-service="patreon" data-user="12793">
    >>很显然，这里是给出了完整链接，保存的方法仍然是平台（patreon）userid（12793）postid（1615）
    >>需要给每一个帖子注入一个下载按钮
    <a href="/patreon/user/12793/post/1615" class="image-link">
      <header class="post-card__header">
            Thresh WIP
      </header>
        <div class="post-card__image-container">
            <img class="post-card__image" src="https://img.pawchive.st/thumbnail/data/ef/b2/efb25135d56158ef48605d5799e04cd19f8e8e4b91281e.jpg">
          </div>
      <footer class="post-card__footer">
       <div>
        <div>
  <time class="timestamp " datetime="2026-06-19 18:36:27">
      2026-06-19 18:36:27
  </time>
        <div>
            1 attachment
          
        </div>
          </div>
            <img src="/static/small_icons/patreon.png">
          </div>
      </footer>
    </a>
  </article>
    </div>
  </div>
4.这是帖子页的格式
  a.在这里插入下载当前页：<div class="post__info">
        <h1 class="post__title">
          
            <span>Thresh WIP</span> <span>(Patreon)</span>
          
        </h1>
        
          <div class="post__published" style="margin: 0.125rem 0;">
            <div style="width: 89px; display: inline-block;">Published:</div> 2026-06-19 18:36:27
           </div>
        
        
        <div class="post__added" style="margin: 0.125rem 0;">
          
              <span> <div style="width: 89px; display: inline-block;">Imported: </div> 2026-06</span>
          
        </div>
        
        <div class="post__actions">
          
            <button
              class="post__flag"
              type="button"
              hx-post="/api/v1/patreon/user/12227893/post/161545280/flag"
              hx-trigger="click[requiresLogin(event, 'Flagging')]"
              hx-target="this"
              hx-swap="outerHTML"
              hx-select="unset"
              hx-confirm="Are you sure you want to flag this post for reimport? Only do this if data in the post is broken/corrupted/incomplete. This is not a deletion button."
            >
              <span class="post__flag-icon">⚑</span>
              <span>Flag</span>
            </button>
          >>下载当前页按钮放到这里
        </div>
      </div>
    b.正文格式如下：<div class="post__body">
    <h2>Content</h2>
    <div class="post__content">
      <p>2xko something</p>
    </div>
    <h2>Files</h2>
    <div class="post__files">
          <div class="post__thumbnail">
            <figure> 
                
                >>
<div class="post__body">

    <h2>Videos</h2>
    <script>window.videoAds = [];</script>
    <ul class="post__videos" style="text-align: center;list-style-type: none;">
        <li>
          <summary>2026-God Strength(Ornn&amp;Volibear)-Final.mp4</summary>
          >>需要下载这里的src和下面a href的链接，过滤重复内容即可
          <div id="fluid_video_wrapper_kemono-player0" class="fluid_video_wrapper mobile fluid_player_layout_default" style="width: 100%; height: 100%; border-radius: 0px; overflow: hidden;"><video id="kemono-player0" playsinline="" preload="none" class="post__video js-fluid-player" webkit-playsinline="" style="border-radius: 0px; height: 100%; width: 100%; cursor: default;">
            <source src="https://file.pawchive.st/data/a7/36/a73687c06ff57073ba8a53c0f1987582647ea7aae5b312673c97c65ff19fd4fd.mp4?f=2026-God%20Strength%28Ornn%26Volibear%29-Final.mp4" type="video/mp4">
          </video><div class="fluid_subtitles_container" style="bottom: 46px;"></div><div class="fluid_player_skip_offset"><div class="fluid_player_skip_offset__backward"><div class="fluid_player_skip_offset__backward-icon"></div></div><div class="fluid_player_skip_offset__forward"><div class="fluid_player_skip_offset__forward-icon"></div></div></div><div class="vast_video_loading" style="display: none;"></div><div class="fluid_controls_container fade_in"><div class="fluid_controls_left"><div class="fluid_button fluid_button_play fluid_control_playpause"></div></div><div class="fluid_controls_progress_container fluid_slider"><div class="fluid_controls_progress"><div class="fluid_controls_currentprogress" style="background-color: red;"><div class="fluid_controls_currentpos"></div></div></div><div class="fluid_controls_buffered" style="width: 0px;"></div><div class="fluid_controls_ad_markers_holder"></div><div class="fluid_timeline_preview" style="display: none; position: absolute;">00:00</div></div><div class="fluid_controls_right"><div class="fluid_button fluid_control_fullscreen fluid_button_fullscreen" title="Full Screen"></div><div class="fluid_button fluid_control_mini_player fluid_button_mini_player" title="Mini Player"></div><div class="fluid_button fluid_control_theatre fluid_button_theatre" title="Theatre Mode" style="display: inline-block;"></div><div class="fluid_button fluid_control_cardboard fluid_button_cardboard" title="Cardboard"></div><div class="fluid_button fluid_control_subtitles fluid_button_subtitles" title="Captions"></div><div class="fluid_button fluid_control_video_source fluid_button_video_source" title="Source" style="display: none;"></div><div class="fluid_button fluid_control_playback_rate fluid_button_playback_rate" title="Playback Rate"></div><div class="fluid_button fluid_control_download fluid_button_download" title="Download"></div><div class="fluid_control_volume_container fluid_slider"><div class="fluid_control_volume"><div class="fluid_control_currentvolume" style="width: 56px;"><div class="fluid_control_volume_currentpos" style="left: 50.5px;"></div></div></div></div><div class="fluid_button fluid_button_volume fluid_control_mute"></div><div class="fluid_control_duration"><div class="fluid_control_live_indicator"></div><div class="fluid_fluid_control_duration">00:00 / 00:00</div></div></div></div><div class="fluid_context_menu" style="display: none; position: absolute;"><ul><li class="context_option_play">Play</li><li class="context_option_mute">Mute</li><li class="context_option_fullscreen">Fullscreen</li><li>Fluid Player v3</li></ul></div><div class="fluid_html_on_pause fluid_initial_play_button_container"><div class="fluid_initial_play" style="background-color:#333333"><div class="fluid_initial_play_button"></div></div></div></div>
        </li>
    </ul>
    <h2>Downloads</h2>
    <ul class="post__attachments">
        <li class="post__attachment">
            >>需要下载这里的href和下面上面视频播放器链接，过滤重复内容即可
          <a class="post__attachment-link" href="https://file.pawchive.st/data/a7/36/a73687c06ff57073ba8a53c0f1987582647ea7aae5b312673c97c65ff19fd4fd.mp4?f=2026-God%20Strength%28Ornn%26Volibear%29-Final.mp4" download="2026-God%20Strength%28Ornn%26Volibear%29-Final.mp4">
            Download 2026-God Strength(Ornn&amp;Volibear)-Final.mp4
          </a>
        </li>
    </ul>
    <h2>Content</h2>
    <div class="post__content">
        >>如果出现了链接，需要匹配并提示用户，暂时可以先放到控制台
      <p>Thank you all for your patience! </p><p>This is the Final version,hope you like it</p><p>Link:</p><p><a href="https://www.dropbox.com/scl/fo/u4hd6i6xbalmxjx4zu6cc/APg3pVy9_MN6tvlLg7hDFtU?rlkey=39x5n3dcs2pu7glmuuu85wds8&amp;st=8q9nj3ky&amp;dl=0" rel="noopener noreferrer">https://www.dropbox.com/scl/fo/u4hd6i6xbalmxjx4zu6cc/APg3pVy9_MN6tvlLg7hDFtU?rlkey=39x5n3dcs2pu7glmuuu85wds8&amp;st=8q9nj3ky&amp;dl=0</a></p><p><a href="https://www.dropbox.com/scl/fo/u4hd6i6xbalmxjx4zu6cc/APg3pVy9_MN6tvlLg7hDFtU?rlkey=39x5n3dcs2pu7glmuuu85wds8&amp;st=8q9nj3ky" rel="noopener noreferrer">https://www.dropbox.com/scl/fo/u4hd6i6xbalmxjx4zu6cc/APg3pVy9_MN6tvlLg7hDFtU?rlkey=39x5n3dcs2pu7glmuuu85wds8&amp;st=8q9nj3ky</a></p>
    </div>
    <h2>Files</h2>
    <div class="post__files">
          <div class="post__thumbnail">
            <figure>
                >>过滤使用href的链接，img的src是它的预览图
              <a class="fileThumb image-link" href="https://file.pawchive.st/data/b5/b1/b5b115113aee858627c65cd094aa6955ad630e3d658d08c38bead120d0a1dd82.png?f=P4.png" download="P4.png">
                <img data-src="https://img.pawchive.st/thumbnail/data/b5/b1/b5b115113aee858627c65cd094aa6955ad630e3d658d08c38bead120d0a1dd82.png" src="https://img.pawchive.st/thumbnail/data/b5/b1/b5b115113aee858627c65cd094aa6955ad630e3d658d08c38bead120d0a1dd82.png" loading="lazy">
              </a>
            </figure>
          </div>
    </div>
    </div>
4.由于帖子使用静态的加载方法，下载帖子时需要先向地址请求HTML，然后过滤其中的可下载项，然后提示用户其中的外部链接（例如dropbox）。