// Brings up the QEMU-only OpenCores Ethernet MAC as a regular esp_netif ("ETH_QEMU")
// so lwIP sockets (WebServer, AsyncTCP, WebSockets, HTTPClient) work under
// `qemu-system-xtensa -machine esp32s3 -nic user,model=open_eth`.
//
// The precompiled pioarduino ESP-IDF libs are built without CONFIG_ETH_USE_OPENETH,
// so the driver sources (Apache-2.0, ESP-IDF release/v5.5) are vendored next to this file.
// NEVER call this on real hardware: the driver aborts if the MAC sanity check fails
// (and it reuses the Wi-Fi MAC interrupt source).
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Starts the MAC/PHY + DHCP client. Returns false on driver errors.
bool qemu_eth_start(void);
// Blocks until DHCP assigned an IPv4 address (QEMU slirp: 10.0.2.15) or timeout. Returns IPv4 (network order) or 0.
uint32_t qemu_eth_wait_ip(uint32_t timeout_ms);

typedef struct {
    bool link;           // PHY link (QEMU monitor `set_link`): ETHERNET_EVENT_CONNECTED / DISCONNECTED
    uint32_t ip;         // the netif's IPv4 now (network order), 0 = none (link down drops the lease)
    uint32_t link_ups, link_downs, leases;
    uint32_t lease_ms;   // uptime (ms) of the last DHCP lease
    int rx_skew;         // RX ring position the driver had to realign at the last link-up (0 = was in step)
} qemu_eth_link_t;
void qemu_eth_link(qemu_eth_link_t *out);
// Restarts the DHCP client (stop → start): the netif-level "reconnect" of the stale-link guard.
bool qemu_eth_renew(void);

#ifdef __cplusplus
}
#endif
