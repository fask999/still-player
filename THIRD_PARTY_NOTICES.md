# Third-party notices

This document records notices for third-party material used by STILL. It does not add or change a project-wide license. The existing license in `native/backend-job/LICENSE.txt` retains its own scope.

## Beefweb v0.10

Copyright 2015-2025 Hyperblast. Beefweb is distributed under the permission notice reproduced in full in [Beefweb-v0.10-LICENSE.txt](docs/licenses/Beefweb-v0.10-LICENSE.txt).

Upstream: [hyperblast/beefweb, tag v0.10](https://github.com/hyperblast/beefweb/tree/v0.10), including [docs/player-api.yml](https://github.com/hyperblast/beefweb/blob/v0.10/docs/player-api.yml). The notice applies to upstream Beefweb material copied into this repository, including [the Player API v0.10 specification](docs/foobar-beefweb-v0.10-api.yml), and to any Beefweb code, plugin or upstream documentation included with a distribution. Preserve the upstream copyright and permission notice with copies or substantial portions. This third-party permission does not license the rest of STILL under MIT.

## Microsoft WebView2 SDK

The bundled `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll` and `WebView2Loader.dll` report SDK version **1.0.4258.31**. Preserve [WebView2-LICENSE.txt](native/apple-host/bin/WebView2-LICENSE.txt) and [WebView2-NOTICE.txt](native/apple-host/bin/WebView2-NOTICE.txt) with those binaries. The [official NuGet license for that version](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31/license) permits source and binary redistribution subject to its notice, disclaimer and non-endorsement conditions. This SDK notice is separate from licensing for a browser Runtime or any private WebView profile.

## foobar2000 SDK and PFC

The spectrum component uses the official foobar2000 SDK and PFC. Preserve [foobar2000-sdk-license.txt](native/foobar-spectrum/package/foobar2000-sdk-license.txt) and [pfc-license.txt](native/foobar-spectrum/package/pfc-license.txt) with the relevant source and distributed component. The SDK notice requires preservation of its source copyright, conditions and disclaimer and prohibits implied endorsement. PFC's zlib-style notice requires accurate origin, marking of altered sources and preservation of the source notice.

These component licenses do not grant redistribution rights for the foobar2000 player. Its [separate player license](https://www.foobar2000.org/license) permits redistribution of unmodified official installers only. An assembled private backend, extracted player binaries, user profile or music collection is not a public release payload.

## Electron and npm dependencies

The current lock pins Electron **45.1.0** and `music-metadata` **12.3.2**. A packaged Electron runtime must retain its matching `LICENSE` and full `LICENSES.chromium.html`; Electron's MIT notice does not replace the component-specific notices in that aggregate file. The [Electron license](https://github.com/electron/electron/blob/main/LICENSE) is maintained upstream.

The current production dependency closure declares MIT for thirteen packages and BSD-3-Clause for `ieee754`. Preserve each dependency's actual copyright and complete license text when packaging it. `music-metadata` carries `LICENSE.txt`. `@tokenizer/token` **0.3.0** embeds its complete MIT notice, Copyright (c) 2020 Borewit, in `README.md`; retain that notice even though the package has no separate LICENSE file. Refer to `package-lock.json` for exact package versions. The final installer must carry the notices matching its actual dependency payload.

## Generated background artwork

`src/renderer/assets/moonlit-lake-v1.png` is recorded as a scenic image generated with the built-in image generation tool from a text prompt, without account material or an application screenshot. Its recorded SHA-256 and provenance are in [asset-provenance.json](docs/asset-provenance.json). This is generated project artwork, rather than a bundled stock photograph or font. Preserve truthful provenance; no project-wide code license or guarantee of exclusive copyright is inferred from generation.

## NSIS installer stub

NSIS is a build tool and is not itself a release payload. The [official NSIS license](https://nsis.sourceforge.io/License) covers its core and zlib compression module under zlib/libpng terms, bzip2 under its own notice, and LZMA under CPL 1.0 with a linking exception. The complete [NSIS 3.13 COPYING text](docs/licenses/NSIS-3.13-COPYING.txt) is preserved from the official build-tool ZIP. An unmodified zlib stub avoids the additional LZMA-module conditions. Preserve the applicable NSIS notices and accurate origin for the actual installer stub and any included plugins. Final installer notices must reflect the compressor and components actually used; this notice does not assign an NSIS license to STILL.
