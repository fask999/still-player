# Private local foobar backend plan

This build is for the user's own Windows machine. It reuses unmodified installed binaries in a separate portable directory; it does not claim a modified foobar binary or an Apple Music decoder. The original installation, its profile, backups and music remain untouched. The included foobar license permits redistribution of its unmodified official installer only; this assembled directory is not a public distribution artifact. Private local use is a separate use case.

The reviewed destination is `Still/backend/foobar2000` for source runs and `<directory containing Still.exe>/backend/foobar2000` for the private packaged app. A `portable_mode_enabled` marker and the new directory's own `profile` prevent using the original profile. Beefweb uses dedicated port **18880**, `allowRemote:false`, and explicit music directory roots. No startup import CLI is used.

The read-only inventory on 2026-10-30 selected **106 files / 47,066,621 bytes (44.9 MiB)**. `scripts/backend-manifest.js` produces the full per-file relative path, byte count, SHA-256 and copy mode without writing anything by default:

```powershell
node scripts/backend-manifest.js --source D:\foobar2000 --destination D:\foobar2000\Still\backend\foobar2000 --music-dir E:\音乐 --music-dir D:\foobar2000\Still\scripts\foobar-probes
```

The explicit allowlist is:

| Group | Included files |
| --- | --- |
| Core | `foobar2000.exe`, `fooHelper.exe`, `portable_mode_enabled`, 17 explicitly named supporting DLLs, `doc/license.html` |
| C runtime | Only files within the existing `runtime` directory; symlinks and junctions are rejected |
| Standard components | `foo_input_std`, `foo_ui_std`, `foo_unpack`, `foo_dsp_std`, `foo_dsp_eq` |
| User components | `foo_beefweb`, `foo_dsd_converter`, `foo_dsd_processor`, `foo_input_dvda`, `foo_input_sacd`, `foo_input_tak`, `foo_input_tta`, `foo_out_asio`, `foo_out_asio+dsd`; their existing dependent files are included |
| Seed settings | Four matching audio component `.cfg` files, `profile/version.txt`, a read-only SQLite backup of `profile/config.sqlite` |

`Still`, all backup directories, all music, original playlists/media-library/metadb, EsLyric scripts and component, playcount, networking/converter/file-operation components, encoders, themes, shell association tools, running locks and uninstallers are excluded. Runtime/profile code directories are traversed individually; the source installation root is never copied recursively. Root filenames and component folder names are fixed in code.

The source's persisted `core.output.mode` and `core.output.device` identify the DX1 II exclusive selection. Its live process was still observed as PID 4972 during inspection, so no consistent whole-profile copy was claimed or performed. Assembly refuses while that exact original executable is running. The SQLite backup opens the source read-only, includes committed WAL state, runs `PRAGMA integrity_check` on the destination and records both source and resulting hashes. Persisted settings cannot establish unflushed live preferences or prove actual DAC format. No original playlists are seeded into the backend; STILL retains its separate imported library.

After explicit review, the private materializer may be called as `materializeBackend(plan,{privateUse:true})`. It rechecks the reviewed manifest, requires a new target, writes into a sibling stage, verifies copied bytes, writes only the new profile's Beefweb configuration and publishes the stage by rename. It does not launch foobar. A failed stage is retained for inspection; the code neither deletes a user directory nor silently retries. Do not run `--copy-private` until the designated leader authorizes real assembly.

The new configuration is equivalent to:

```json
{
  "port": 18880,
  "allowRemote": false,
  "musicDirs": ["E:\\音乐", "D:\\foobar2000\\Still\\scripts\\foobar-probes"],
  "permissions": {"changePlaylists": true, "changeOutput": true, "changeClientConfig": false}
}
```

Only the dedicated profile receives this file. Beefweb 0.10's supplied source (`settings.cpp`) reads profile config followed by `BEEFWEB_CONFIG_FILE`; the managed child receives an absolute path to its own config. Imported paths are still verified by exact backend path and subsong. A future native-picker-authorized root expansion must affect only this profile and reload only an owned backend; browsing or switching source tabs does not stop audio.

`createBackendManager` will verify the private manifest and exact listening process before reuse/start. Normal app launch may call `initialize({start:true})`; smoke uses `initialize({start:false})` and cannot launch or configure a backend. The manager starts only this destination's executable with `/hide`, waits for real Beefweb version/root readback, and closes only an instance it personally started after exact PID/executable verification. Process ownership and dedicated port prevent attaching to or exiting the original installation.

Cross-engine playback first cancels pending local work, waits for dispatched control HTTP settlement, stops locally and measures release using the existing CoreAudio probe's **shared Initialize** mode. The probe never calls `Start`, emits JSON and releases COM handles before process exit. Missing probe/ambiguous endpoint/device-in-use does not count as release. It reports endpoint availability at measurement time, not actual DAC sample format. The main coordinator starts Apple playback only after `{released:true}`; returning to local audio requires an explicit new play and an **exclusive Initialize** availability check. Its private validation format is 48 kHz / 32-bit / stereo, supported by the DX1's recorded [S_OK query](../scripts/foobar-evidence/acceptance-1793332191087/format-support-matrix.json) and [no-Start Initialize step](../scripts/foobar-evidence/acceptance-1793332324229/result.json). Unsupported or mismatched readback fails closed. This is only a validation container; the 16-bit source fixtures and foobar/DSP/output settings remain unchanged, and actual DAC format remains unknown. Source changes for this check do not modify the frozen running V1 package.

Official `/hide` behavior is described by the [foobar Windows change log](https://www.foobar2000.org/changelog). Profile/config behavior is supported by the supplied Beefweb 0.10 source and local configuration documentation. Real copied-backend startup, same-machine isolation, device release and playback remain integration checks for the sole audio tester after authorization.

## Reviewed assembled source manifest

These hashes were recomputed after the original foobar exited cleanly, before the one authorized private assembly. Full review and verification records are in `docs/evidence/backend-private-reviewed-manifest-20261030.json` and `backend-private-copy-verification-20261030.json`. No backend was started by assembly.

| Relative path | Bytes | SHA-256 | Mode |
| --- | ---: | --- | --- |
| `foobar2000.exe` | 4793224 | `4a38abddbe1de40df75814dae2d40753b07cb3074c58ace59f98fe75ddb71134` | copy |
| `fooHelper.exe` | 61328 | `5b32e5f00e9bb6768335a31e995ced4be7fe00f14f758db8cd44e73640bef6b3` | copy |
| `portable_mode_enabled` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | copy |
| `avcodec-fb2k-62.dll` | 1325056 | `2ee5dd3eec66584d7cb6b71d9bc116d6c634d51decd79789c88d22284e90c288` | copy |
| `avformat-fb2k-62.dll` | 318976 | `5944bcc7217c874d8c704b9a1a15c62187ca56c7ba7c4f50e04f04a84d79b3d8` | copy |
| `avutil-fb2k-60.dll` | 1225728 | `3901384e4dace4511e742dc1ddd5850bbc8810ee23e4b93a795f1dc4aa521c6a` | copy |
| `concrt140.dll` | 324208 | `2405355f0a58067b258f8df33c327e3a3d716eaac5a3a5aebb757842d85bd376` | copy |
| `msvcp140.dll` | 557728 | `0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9` | copy |
| `msvcp140_1.dll` | 35952 | `bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d` | copy |
| `msvcp140_2.dll` | 280200 | `3ea06f0ee098b4823cb79599df3780e7f23cce52c19aac31d2a0d47efe33a5e9` | copy |
| `msvcp140_atomic_wait.dll` | 50304 | `640b2aefced484d0368eea5bdd06addd0658a3a70a49256e560d6923b404a479` | copy |
| `msvcp140_codecvt_ids.dll` | 31872 | `f2069a52880ec885ee7f0511186100eb7fada0411a2b4948fafea7735b878a18` | copy |
| `PP-UWP-Interop.dll` | 43840 | `f21a0a4fc0607136d9b9f304a8dbd5e3d85635841d1c0b892a0b5273cb3cd6f7` | copy |
| `shared.dll` | 155536 | `161075c7ec94909e8b342c0d5b2101cc34a3afcb94cd597af8f22116cd6fb9d7` | copy |
| `sqlite3.dll` | 1089096 | `26517154d85ff4ee74281ffb76afbe9a3dc05b5cfc82b2486e721993a39c8d60` | copy |
| `vccorlib140.dll` | 352384 | `19839407c3fdbc824e5bce189bf68ddf8097f12ec28b757797ffa0415c144ddd` | copy |
| `vcruntime140.dll` | 124544 | `d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066` | copy |
| `vcruntime140_1.dll` | 49792 | `1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f` | copy |
| `vcruntime140_threads.dll` | 38528 | `219915cf20822f34d5e7c1fdd4e21ae7f3396881096c51036225fb8f84b47afa` | copy |
| `zlib1.dll` | 95744 | `5f4e700b729dbd3945bc208400d492f293fb121736981bff341c9b5ca9c8ef01` | copy |
| `doc/license.html` | 4865 | `cede3abf343967abd583f5a73cd6cc1d534e87499264cdbc7e354d10c5e45bf1` | copy |
| `runtime/api-ms-win-core-console-l1-1-0.dll` | 22896 | `59d78aec2611cc356702b3836cd6bc66575c594b458b7830877001a89a767547` | copy |
| `runtime/api-ms-win-core-console-l1-2-0.dll` | 22888 | `5cd07f83247cbe9cfbc0932b6499ec5230b2163ec12421911eb5ee261462b33f` | copy |
| `runtime/api-ms-win-core-datetime-l1-1-0.dll` | 22896 | `78f6c8078b69676497ad76b9ccc337a61f3020bca618ab0141f10972903b1bde` | copy |
| `runtime/api-ms-win-core-debug-l1-1-0.dll` | 22872 | `1f5b7d47e991a1dc056f2f50cc62d4f77a51a590c56379f6fa4ecb5455f9b6f2` | copy |
| `runtime/api-ms-win-core-errorhandling-l1-1-0.dll` | 22896 | `a1d3ec684400c79d2ec827ddb6d52f4121591694cf464dd653d6b239d136b0bd` | copy |
| `runtime/api-ms-win-core-fibers-l1-1-0.dll` | 22872 | `c1d20209067be99a3c69a797e3f499dbe20f04c493ce289e55496a1d5066ca4b` | copy |
| `runtime/api-ms-win-core-fibers-l1-1-1.dll` | 22912 | `7fe8a461983247ce74c1e1b09171c68a230a11a3c56142aad718f76ad81780e6` | copy |
| `runtime/api-ms-win-core-file-l1-1-0.dll` | 26992 | `3a1cf66477892df44b9f451c8f947cac1329bc1f02399ca63621574154b51538` | copy |
| `runtime/api-ms-win-core-file-l1-2-0.dll` | 22872 | `ba215618e8cc09ff2eaa664abbb0732b07db0e4661e16b04d170fc6668694304` | copy |
| `runtime/api-ms-win-core-file-l2-1-0.dll` | 22872 | `75b953a6a99b9491244fa56c68ade516119ac473b8e8c64c152fdfd09df11bdc` | copy |
| `runtime/api-ms-win-core-handle-l1-1-0.dll` | 22872 | `bd24621589d33a765542e6a109def69f61156bcd1cdc4a0c2e954ffb58de0432` | copy |
| `runtime/api-ms-win-core-heap-l1-1-0.dll` | 22912 | `165c0c680b9ad7cf0d10cb02a6dbba897205bb27f7adfb00dfb0cefeb49a40c0` | copy |
| `runtime/api-ms-win-core-interlocked-l1-1-0.dll` | 22888 | `697c2de8a219c586869df7b70198aa9d93831b907a2151841bc63943b42e4816` | copy |
| `runtime/api-ms-win-core-kernel32-legacy-l1-1-1.dll` | 22896 | `71f4587da6097b837a0631c5c4804b94a3f6a419b9b5665f4e6333453a22fb98` | copy |
| `runtime/api-ms-win-core-libraryloader-l1-1-0.dll` | 22912 | `5c4d953db991d849c22782419a8b436d6fc639c5412c34ea672a0c8891b6ca13` | copy |
| `runtime/api-ms-win-core-localization-l1-2-0.dll` | 22896 | `16256dfc26826296c8c88471b176f98d3e7ad9a4afacdc5350d0fdd470f40909` | copy |
| `runtime/api-ms-win-core-memory-l1-1-0.dll` | 22872 | `beb72ed3c23a5227523bbf9077c57e36540fac0c422c30ec3b63599e4edd2f9a` | copy |
| `runtime/api-ms-win-core-namedpipe-l1-1-0.dll` | 22872 | `a44c1d24b3c342fb32ae2836ef890777c1950333c1c167d76383dcf093c8e8c3` | copy |
| `runtime/api-ms-win-core-processenvironment-l1-1-0.dll` | 22896 | `bf79af5629a7e2df040ea1a26e3f74137f782f378ee2cedaca49db1fb4957800` | copy |
| `runtime/api-ms-win-core-processthreads-l1-1-0.dll` | 22912 | `ffe2375e1d29d541659aa47aead5636afee8c17162e1b47dd7afb46ed52a78b3` | copy |
| `runtime/api-ms-win-core-processthreads-l1-1-1.dll` | 22888 | `9de901ebf9dac5e9fad669a065cc2c8c06c2b02d74bcdaf472f02497538d5797` | copy |
| `runtime/api-ms-win-core-profile-l1-1-0.dll` | 22872 | `69f5ed9328ff5fdbc14fff88c41184bfe7e8d0ef5d93f5fb467dd6c263b0d51f` | copy |
| `runtime/api-ms-win-core-rtlsupport-l1-1-0.dll` | 22896 | `acb9c973980ab441226b30e3647a334ea31c1604d84c6a0aebc2ea4993358901` | copy |
| `runtime/api-ms-win-core-string-l1-1-0.dll` | 22888 | `c6372337c9ce1dd2a521d9390fbc867d7445b44d360af8a56e2c0a860297da3f` | copy |
| `runtime/api-ms-win-core-synch-l1-1-0.dll` | 22896 | `7e0eb833be2378f0686f958a74edb3fd44cc902c27d597f4ed3cfd7f206255f3` | copy |
| `runtime/api-ms-win-core-synch-l1-2-0.dll` | 22896 | `3ba58aecb8e9e6d6620b98e0d8252a005f2bc350e79d1b182cb59883abe277cf` | copy |
| `runtime/api-ms-win-core-sysinfo-l1-1-0.dll` | 22872 | `e40f7232de970478d9244ba4d8279c4e3bf30079b072e13298c663b529cb0787` | copy |
| `runtime/api-ms-win-core-sysinfo-l1-2-0.dll` | 22872 | `c1eb0f061e8a3b0fc7b98a63eaf9dec264ce013fb9763c4d86dd14a670350c93` | copy |
| `runtime/api-ms-win-core-timezone-l1-1-0.dll` | 22872 | `54a9178b6df11f2024e2b38761136d24d8ba0586b2cb4ee2c4722da8d6037b8e` | copy |
| `runtime/api-ms-win-core-util-l1-1-0.dll` | 22896 | `a8c4b20070cd6c9346024b97ef15269d71bfb37796bccc5b439cbd3a3e5c3d9c` | copy |
| `runtime/api-ms-win-crt-conio-l1-1-0.dll` | 22912 | `963ea14aba2ecfd7c61bb0d796292fff22ace2da5968d8b1db314345ae28cf4a` | copy |
| `runtime/api-ms-win-crt-convert-l1-1-0.dll` | 26968 | `b88f98bcb692c6c5b4438767308f44adefda590710941eaa5c4af204f24f4321` | copy |
| `runtime/api-ms-win-crt-environment-l1-1-0.dll` | 22872 | `a87560fd7d1bafb9e5519443253e0493e399d1081246b8f29a57e5e7346cd7bc` | copy |
| `runtime/api-ms-win-crt-filesystem-l1-1-0.dll` | 22896 | `0d9a3d6106d280e6918a10051cdbf01f7425a9a92cffa070fd4b73fa8aa937bb` | copy |
| `runtime/api-ms-win-crt-heap-l1-1-0.dll` | 22912 | `a564f90def67228e35a29ee1f11492c97be7a094ac151e93c03b1a6969cbbc25` | copy |
| `runtime/api-ms-win-crt-locale-l1-1-0.dll` | 22896 | `6365a6acc38115f1b3ff099e918906b2edc46262a8b9c203d1768d0f4f0ee1b3` | copy |
| `runtime/api-ms-win-crt-math-l1-1-0.dll` | 31064 | `f35e6b89190265a41b449bbb91d6004be673be313e60cceff4bb39e408aab46e` | copy |
| `runtime/api-ms-win-crt-multibyte-l1-1-0.dll` | 31104 | `9a0db1e28ed4fe59cd930892511810628b2f36c3cba4f98403f17618619baa60` | copy |
| `runtime/api-ms-win-crt-private-l1-1-0.dll` | 76144 | `553e11871e01f94d331be5e21138418d5e34023c6531d79f46f62fc47798e5c7` | copy |
| `runtime/api-ms-win-crt-process-l1-1-0.dll` | 22872 | `05b29818af66f0b76903792ba37dc088ff330209e0de6b2cc8edbd518cc999d0` | copy |
| `runtime/api-ms-win-crt-runtime-l1-1-0.dll` | 27008 | `659a5d57d7235e0892e6162828c5b144ee911f0c9c92844c1eab0961b88b1172` | copy |
| `runtime/api-ms-win-crt-stdio-l1-1-0.dll` | 26984 | `55397a894ca181e23dc0f67d857f83a73b293c16ef2854f9c3dc939835f03c2f` | copy |
| `runtime/api-ms-win-crt-string-l1-1-0.dll` | 26992 | `3dc14795df69a59fab83339e5e9d627aa66605f5e45adeb8b1ebdb92f36f6c67` | copy |
| `runtime/api-ms-win-crt-time-l1-1-0.dll` | 22888 | `5fd56ad9d9a8df953edd9796335071fd8cd5202644a094185bbd9e494e46c64a` | copy |
| `runtime/api-ms-win-crt-utility-l1-1-0.dll` | 22912 | `4d90d577248b381608f6a336a7fb5d7af10a0eb1723987704bd90979d147115f` | copy |
| `runtime/runtime.manifest` | 2682 | `64ef5ad1640c795be2063b989bdc915cf7761cd35caa512047ad7597df16e6ad` | copy |
| `runtime/ucrtbase.dll` | 1362288 | `8c9d0d38f521e86a780ae9b2a7c222ee14aad597dbe85a05b9241a9a52782aed` | copy |
| `components/foo_dsp_eq.dll` | 314760 | `2aacd2e73f17a8ac450579b29b6f73f5bbdb40682d8365f205203a1454580294` | copy |
| `components/foo_dsp_std.dll` | 280464 | `7136e6ff7e2ab23e18f4f48c652212c2acbdb99219868866406b231a3ff2604d` | copy |
| `components/foo_input_std.dll` | 2507664 | `a7e4a6b7b954797f3fac958c3ff61792c345a8eb293876bfd3a541574c21e34f` | copy |
| `components/foo_ui_std.dll` | 2382224 | `89416c1da9e1a646f09b75c3adecc01a6c7376e8684c29f6f751bce6e38ed22c` | copy |
| `components/foo_unpack.dll` | 620936 | `d5ae6696ff0cc0e514102e2af7fc0120d21529014913f77c4a5c4c056ef5717a` | copy |
| `profile/user-components-x64/foo_beefweb/beefweb.root/bundle.css` | 13999 | `d2971a3ea2b20dc6e80e49cbc252be899ed020dbe813d8a0a1cf6000c82e5bb6` | copy |
| `profile/user-components-x64/foo_beefweb/beefweb.root/bundle.js` | 365809 | `5855a12fd0fefb7615e37607e427c3d316ad63eb91f3ad4d087fc4289f79458d` | copy |
| `profile/user-components-x64/foo_beefweb/beefweb.root/index.html` | 442 | `6f00e616ff71870b09b1fc1635fd3c72c528fab0123b9f4cf89d16cdab76cc81` | copy |
| `profile/user-components-x64/foo_beefweb/beefweb.root/sprite.svg` | 57962 | `ee23575972d7267a8a34f72294bccf37ad1c36462e952278dbce2bee728ae1e5` | copy |
| `profile/user-components-x64/foo_beefweb/beefweb.root/third-party-licenses.txt` | 33686 | `149f2b079b42e4be0f2ed01fbb18752f3f5f59d0d30534fb678d375b89f46fd5` | copy |
| `profile/user-components-x64/foo_beefweb/foo_beefweb.dll` | 1473024 | `68cbe661ee2cfb15268d2282817cb9ac329780e87641ee67d63a5db3b571c31c` | copy |
| `profile/user-components-x64/foo_dsd_converter/foo_dsd_converter.dll` | 577536 | `51680e5b54cf9fe0f7fec27f72d1727110a8397c00414c96404f91064659ad6f` | copy |
| `profile/user-components-x64/foo_dsd_processor/foo_dsd_processor.dll` | 8987648 | `eff9f5156dd538a35670ec14aa8b2b40c578fc921fe402aa7e455e89df589070` | copy |
| `profile/user-components-x64/foo_input_dvda/foo_input_dvda.dll` | 905216 | `b0512a6bbdefb9c0fc757899e95ca6f02f5e534bcb2dab93dcafdccd7e2e191e` | copy |
| `profile/user-components-x64/foo_input_sacd/dsd_transcoder_ctl_x64.exe` | 1083904 | `da48f561e2ba5a530fd5decadb10c62908362cc9e79dc15e29c9f3506a4123a0` | copy |
| `profile/user-components-x64/foo_input_sacd/dsd_transcoder_ctl.exe` | 729600 | `c21a273b56c2335c951688d7663c3bff0d81c5ee324b87ea719b1ab3f2868977` | copy |
| `profile/user-components-x64/foo_input_sacd/dsd_transcoder_x64.dll` | 291840 | `223a0e0fb792cded2764cd5e45a3a48dad7e721067e3b6400da73ff5bd113701` | copy |
| `profile/user-components-x64/foo_input_sacd/dsd_transcoder.dll` | 95232 | `20e7edacbc02f0e98898daf5aa68cbfcebfd7b4729c82ccc95f3b36a0525096a` | copy |
| `profile/user-components-x64/foo_input_sacd/filters/30kHz_641.txt` | 24376 | `723c3a8d0ffba6b7955e5e7a7ea1d1a1fe5c809b8ff7216181e8e30f08146bbc` | copy |
| `profile/user-components-x64/foo_input_sacd/filters/40kHz_641.txt` | 24375 | `82d3cfde59f8a3762a04607b6739cc2beaa06d6c1363367efa6a637f85e94b17` | copy |
| `profile/user-components-x64/foo_input_sacd/filters/50kHz_641.txt` | 24375 | `de9474ecbc01ad2a353f7253bbd5cc1525301367e50453b9258d8e184658fed9` | copy |
| `profile/user-components-x64/foo_input_sacd/filters/60kHz_641.txt` | 24375 | `a31527a402a1366a3f111a88e97ab76144faeb7460d2522eba09da0e5d263b5d` | copy |
| `profile/user-components-x64/foo_input_sacd/foo_input_sacd.dll` | 11086336 | `0ca4d66cc230679fac738c2ee48eebf8c55291a97660fd5eadb18fa08fd8bb91` | copy |
| `profile/user-components-x64/foo_input_tak/foo_input_tak.dll` | 187904 | `20cd35ef980cc237fc2f042c9e743115207077f4b5b2bf4b397bfe583ef4182e` | copy |
| `profile/user-components-x64/foo_input_tak/tak_deco_lib.dll` | 323072 | `8f0e97949187adccac9a469c64a0534c6bb296d5d73ac19f6c6e2902585f2a1f` | copy |
| `profile/user-components-x64/foo_input_tta/foo_input_tta.dll` | 228352 | `73a8341cc521dd46fc7df0983e563755f2b99bacfa0f7506f9c3038090b20faf` | copy |
| `profile/user-components-x64/foo_out_asio/ASIOhost32.exe` | 86528 | `122312ad3c112d6b6a46d78ae923b8b671aee3937f7e9975f4ed89054ddaf8a2` | copy |
| `profile/user-components-x64/foo_out_asio/ASIOhost64.exe` | 98304 | `dd0c3cccea39c68bf34cac5a8dc5835a4140f2bdc195f4aaba14f1a6ed5dabab` | copy |
| `profile/user-components-x64/foo_out_asio/foo_out_asio.dll` | 117248 | `5e4c1d0ed9d799658f19a172cee32d965534324c9305ba8dca2ba9af6694f00b` | copy |
| `profile/user-components-x64/foo_out_asio+dsd/ASIOhost32.exe` | 69632 | `9e87693f935eb3fcc6d9881085a083efd2d68411d08da56783aba5e75b76355b` | copy |
| `profile/user-components-x64/foo_out_asio+dsd/ASIOhost64.exe` | 80384 | `ff6693aa03f59914eb260f871c44e13cd0326572ca32dfdc9e96644f2a7a6793` | copy |
| `profile/user-components-x64/foo_out_asio+dsd/foo_out_asio+dsd.dll` | 446976 | `3e142aa9b6201b9af0a1e38d749139402763398a46a470b37e21532f7d1a9cf6` | copy |
| `profile/configuration/foo_dsd_processor.dll.cfg` | 77 | `1537c0f9b42a53a29f34b75840cf52890eed5d2be773519cd198cd5acf98347b` | copy |
| `profile/configuration/foo_input_dvda.dll.cfg` | 180 | `fae8bdde3770170ea067dd27ff791d36bffc073ab029c3246f07a9caf6241211` | copy |
| `profile/configuration/foo_out_asio+dsd.dll.cfg` | 172 | `68508df45eb3efd04189d0b2316bbd1726567d2a5cc07b65fc2ff9274a73a1eb` | copy |
| `profile/configuration/foo_out_asio.dll.cfg` | 123 | `64e0811d5e88c99390b2bbdcb25f9cead5f64203b408c8de83e7fedb793398a5` | copy |
| `profile/config.sqlite` | 77824 | `ec4dac1ed9f1e48c8ed7788be1d89784bd1e7439042222c8fdbe159b15606698` | sqlite-readonly-backup |
| `profile/version.txt` | 19 | `34bd4b85ba2e5553e8c7cd5235e8e291661150a21a385b7cdd171c09fada104a` | copy |
