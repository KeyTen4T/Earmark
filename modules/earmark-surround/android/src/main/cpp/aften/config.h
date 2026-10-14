/**
 * Fixed configuration header for the vendored libaften.
 *
 * Upstream generates this file with CMake (CMakeModules/ConfigHelper.cmake) after probing the
 * compiler, the target machine and the available SIMD instruction sets. We build the encoder as
 * plain, portable C with no SIMD, no threading and no floating-point choice to make, so the
 * probe results are fixed here instead. See ../README.md.
 *
 * Do not add HAVE_MMX / HAVE_SSE* / HAVE_ALTIVEC / HAVE_POSIX_THREADS / HAVE_WINDOWS_THREADS:
 * the whole point of this file is to disable those paths.
 */
#ifndef AFTEN_CONFIG_H
#define AFTEN_CONFIG_H

/* <inttypes.h> is available on glibc and on the Android NDK. */
#define HAVE_INTTYPES_H 1

/* Referenced unconditionally by aften_encode_init() even though the build has no threads. */
#define MAX_NUM_THREADS 32

/* HAVE_BYTESWAP_H is deliberately left undefined: the fallback bswap_16/32/64 in bswap.h are
 * used instead, which is also what Android's bionic needs (it has no <byteswap.h>). */

#endif /* AFTEN_CONFIG_H */
