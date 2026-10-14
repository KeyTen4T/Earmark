cmake_minimum_required(VERSION 3.13)
project(earmarksurround C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# -O2 for every build type, so the release APK gets it regardless of which CMake build type AGP
# selects.
set(CMAKE_C_FLAGS_RELEASE "-O2 -DNDEBUG")
set(CMAKE_C_FLAGS_RELWITHDEBINFO "-O2 -g -DNDEBUG")

set(CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp")

add_compile_definitions(HAVE_CONFIG_H)

add_library(earmarksurround SHARED
  ${CPP_DIR}/jni.c
  ${CPP_DIR}/ac3enc.c
  ${CPP_DIR}/aften/a52enc.c
  ${CPP_DIR}/aften/bitalloc.c
  ${CPP_DIR}/aften/bitio.c
  ${CPP_DIR}/aften/crc.c
  ${CPP_DIR}/aften/dynrng.c
  ${CPP_DIR}/aften/window.c
  ${CPP_DIR}/aften/mdct.c
  ${CPP_DIR}/aften/exponent.c
  ${CPP_DIR}/aften/filter.c
  ${CPP_DIR}/aften/util.c
)

target_include_directories(earmarksurround PRIVATE
  ${CPP_DIR}
  ${CPP_DIR}/aften
)
