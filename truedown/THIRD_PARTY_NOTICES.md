# Third-party notices

## aria2

The TrueDown Windows package includes the `aria2c.exe` command-line download
utility from aria2 1.37.0. aria2 is Copyright (C) 2006, 2019 Tatsuhiro
Tsujikawa and contributors, and is distributed under the GNU General Public
License, version 2 or (at your option) any later version. The complete license
text is included as `ARIA2_COPYING`. The packaged executable matches the
official `aria2-1.37.0-win-64bit-build1.zip` asset at SHA-256
`be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2`.
Corresponding source is available from the
[aria2 1.37.0 source release](https://github.com/aria2/aria2/releases/tag/release-1.37.0).

## modernc.org/sqlite (Linux and macOS)

TrueDown's Linux and macOS binaries include the CGo-free
`modernc.org/sqlite` implementation and its Go runtime dependencies.

Copyright (c) 2017 The Sqlite Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Aria2 Next (optional, not bundled)

TrueDown can, only after an explicit dashboard action, download an optional
Aria2 Next executable directly from the
[AnInsomniacy/aria2-next](https://github.com/AnInsomniacy/aria2-next) GitHub
Release assets. TrueDown verifies the asset against the SHA-256 file published
with that release and verifies its reported version. It does not automatically
follow Aria2 Next releases. Aria2 Next is also distributed under the GNU
General Public License, version 2 or later; its source and copyright notices are
provided in that upstream repository. The `ARIA2_COPYING` file contains the
applicable GPL version 2 text.

## gdown

TrueDown's Google Drive resolver is an original Go implementation informed by
the public-link protocol behavior documented and implemented by
[wkentaro/gdown](https://github.com/wkentaro/gdown), reviewed at commit
`7132dabeef63255c6e2b3d555f0928f0f13bdbdb`. gdown is distributed under the
following MIT license:

Copyright (c) 2015 Kentaro Wada.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## RatioGhost

TrueDown's optional tracker-traffic research module is an original Go
implementation informed by the public announce-rewriting behavior of
[RatioGhost](https://github.com/ratioghost/ratioghost), reviewed at commit
`64b641b675b8c88f7c84ee812e69a5274cf49474`. No Tcl/Tk source or bundled
certificate material is included. RatioGhost is Copyright (C) 2006-2015
Yasmine@RatioGhost.com and is distributed under the GNU General Public License,
version 3 or later. The repository's top-level `LICENSE` contains the applicable
GPL version 3 text.
