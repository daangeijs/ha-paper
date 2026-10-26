// Logging facade expected by freeink-sdk libraries (and used by HA Paper).
#pragma once
#ifdef X4_NATIVE
#include <cstdio>
#define LOG_ERR(tag, fmt, ...) std::fprintf(stderr, "[E][%s] " fmt "\n", tag, ##__VA_ARGS__)
#define LOG_WRN(tag, fmt, ...) std::fprintf(stderr, "[W][%s] " fmt "\n", tag, ##__VA_ARGS__)
#define LOG_INF(tag, fmt, ...) std::fprintf(stderr, "[I][%s] " fmt "\n", tag, ##__VA_ARGS__)
#define LOG_DBG(tag, fmt, ...) ((void)0)
#else
#include <Arduino.h>
// Serial `[I][TAG] message` + the log ring behind GET /api/v1/logs (src/net/log.cpp, #200). Lines are cut at 255 bytes.
void x4Log(char level, const char* tag, const char* fmt, ...) __attribute__((format(printf, 3, 4)));
#define LOG_ERR(tag, fmt, ...) x4Log('E', tag, fmt, ##__VA_ARGS__)
#define LOG_WRN(tag, fmt, ...) x4Log('W', tag, fmt, ##__VA_ARGS__)
#define LOG_INF(tag, fmt, ...) x4Log('I', tag, fmt, ##__VA_ARGS__)
#define LOG_DBG(tag, fmt, ...) ((void)0)
#endif
