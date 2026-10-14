# Vendored aften 0.0.8

Aften is a small plain-C AC-3 (A/52, "Dolby Digital") encoder. This directory is a trimmed copy of
its `libaften` library, built as part of `libearmarksurround.so`.

## Origin

* Project: Aften: A/52 audio encoder — https://sourceforge.net/projects/aften/
* Version: **0.0.8** (the last release)
* Downloaded from:
  `https://downloads.sourceforge.net/project/aften/aften/0.0.8/aften-0.0.8.tar.bz2`
* Tarball checksums:
  * MD5 `fde67146879febb81af3d95a62df8840` (matches SourceForge's published MD5)
  * SHA-256 `87cc847233bb92fbd5bed49e2cdd6932bb58504aeaefbfd20ecfbeb9532f0c0a`
* Licence: GNU Lesser General Public License v2.1 — see `COPYING` (the unmodified upstream file).
  Aften is based on "The simplest AC3 encoder" from FFmpeg by Fabrice Bellard; copyright notices
  are kept in each file.

The upstream project's own Git history is mirrored at https://github.com/justinruggles/aften, but
that tree is 0.0.8 plus later commits, so the released 0.0.8 tarball above is the source actually
vendored here.

## What was copied

Only the files `libaften` needs to encode, plus the two shared headers it includes:

* Sources: `a52enc.c`, `bitalloc.c`, `bitio.c`, `crc.c`, `dynrng.c`, `window.c`, `mdct.c`,
  `exponent.c`, `exponent_common.c`, `filter.c`, `util.c`
* Headers: `a52.h`, `aften.h`, `aften-types.h`, `bitalloc.h`, `bitio.h`, `common.h`, `crc.h`,
  `cpu_caps.h`, `dynrng.h`, `exponent.h`, `filter.h`, `mdct.h`, `threading.h`, `window.h`,
  plus `bswap.h` and `common.h` from the tarball root (upstream keeps them one level up).
* `COPYING`.

Deliberately **not** copied, and not compiled: the `x86/` and `ppc/` SIMD sources, the `aften`
CLI, the `pcm/` file readers, the C++ bindings, `coupling.c` (dead, not in upstream's build) and
`mem.h` (only used by the SIMD paths).

## Changes made to upstream code

1. **`config.h` added (new file).** Upstream generates this with CMake
   (`CMakeModules/ConfigHelper.cmake`) after probing the compiler, target and SIMD support. Because
   this build is fixed — plain portable C, no assembly, no SIMD, no threads, little-endian — the
   probe results are written out by hand instead. It defines `HAVE_INTTYPES_H` and
   `MAX_NUM_THREADS 32`. `HAVE_MMX`/`HAVE_SSE*`/`HAVE_ALTIVEC`/`HAVE_POSIX_THREADS`/
   `HAVE_WINDOWS_THREADS`/`HAVE_BYTESWAP_H` are intentionally **left undefined**, which disables
   the optional SIMD and threading code and selects the `bswap.h` fallbacks.
2. **`cpu_caps.h` patched.** Upstream's no-SIMD branch defines only `cpu_caps_detect()`, but
   `aften_encode_init()` calls `apply_simd_restrictions()` unconditionally; that symbol only exists
   in the x86/ppc CPU-caps files, which this build does not compile. The patched branch includes
   `aften-types.h` and adds a no-op `apply_simd_restrictions()` stub. (Modern clang treats the
   missing declaration as a hard error, so this is required, not cosmetic.)

No encoder algorithm, table or numeric code was altered.

## Building it

Only ever compiled as C (never C++). Define `HAVE_CONFIG_H` and add both this directory and its
parent to the include path:

```
cc -O2 -std=gnu99 -DHAVE_CONFIG_H -I<this dir> -I<parent> ... a52enc.c ... util.c
```

`../../../../test/roundtrip.sh` builds it this way on the host; `../CMakeLists.txt` builds it for
Android.
