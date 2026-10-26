#include "qemu_eth.h"

#include "esp_eth.h"
#include "esp_eth_mac_openeth.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

static const char *TAG = "qemu_eth";
static EventGroupHandle_t s_events;
static uint32_t s_ip;
static esp_netif_t *s_netif;
static volatile bool s_link;
static volatile uint32_t s_link_ups, s_link_downs, s_leases, s_lease_ms;
volatile int qemu_eth_rx_skew;   // esp_eth_mac_openeth.c: RX ring position found at the last link-up
#define GOT_IP_BIT BIT0

static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data) {
    ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
    s_ip = ev->ip_info.ip.addr;
    s_leases++;
    s_lease_ms = (uint32_t)(esp_timer_get_time() / 1000);   // = Arduino millis()
    ESP_LOGI(TAG, "got IP " IPSTR " gw " IPSTR, IP2STR(&ev->ip_info.ip), IP2STR(&ev->ip_info.gw));
    xEventGroupSetBits(s_events, GOT_IP_BIT);
}

volatile bool qemu_eth_stack_ready = false;   // see esp_eth_mac_openeth.c emac_opencores_rx_task

static void on_eth(void *arg, esp_event_base_t base, int32_t id, void *data) {
    // registered after the netif glue → its START handler (lwip netif creation) already ran
    if (id == ETHERNET_EVENT_START || id == ETHERNET_EVENT_CONNECTED) qemu_eth_stack_ready = true;
    if (id == ETHERNET_EVENT_CONNECTED) {
        s_link = true;
        s_link_ups++;
    }
    if (id == ETHERNET_EVENT_DISCONNECTED) {
        s_link = false;
        s_link_downs++;
    }
}

bool qemu_eth_start(void) {
    s_events = xEventGroupCreate();
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return false;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return false;

    esp_netif_inherent_config_t base = ESP_NETIF_INHERENT_DEFAULT_ETH();
    base.if_key = "ETH_QEMU";
    base.if_desc = "qemu-openeth";
    esp_netif_config_t cfg = {.base = &base, .driver = NULL, .stack = ESP_NETIF_NETSTACK_DEFAULT_ETH};
    esp_netif_t *netif = esp_netif_new(&cfg);
    s_netif = netif;

    eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
    mac_cfg.rx_task_stack_size = 4096;
    eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
    phy_cfg.phy_addr = ESP_ETH_PHY_ADDR_AUTO;
    phy_cfg.autonego_timeout_ms = 100;
    phy_cfg.reset_gpio_num = -1;

    esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mac_cfg);
    esp_eth_phy_t *phy = esp_eth_phy_new_generic(&phy_cfg);  // QEMU emulates a DP83848C (IEEE 802.3 regs)
    if (!mac || !phy) return false;

    esp_eth_config_t eth_cfg = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth = NULL;
    if (esp_eth_driver_install(&eth_cfg, &eth) != ESP_OK) return false;
    if (esp_netif_attach(netif, esp_eth_new_netif_glue(eth)) != ESP_OK) return false;

    esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, on_eth, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, on_got_ip, NULL);
    return esp_eth_start(eth) == ESP_OK;
}

uint32_t qemu_eth_wait_ip(uint32_t timeout_ms) {
    if (!s_events) return 0;
    xEventGroupWaitBits(s_events, GOT_IP_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(timeout_ms));
    return s_ip;
}

void qemu_eth_link(qemu_eth_link_t *out) {
    esp_netif_ip_info_t ip = {0};
    if (s_netif) esp_netif_get_ip_info(s_netif, &ip);
    out->link = s_link;
    out->ip = ip.ip.addr;
    out->link_ups = s_link_ups;
    out->link_downs = s_link_downs;
    out->leases = s_leases;
    out->lease_ms = s_lease_ms;
    out->rx_skew = qemu_eth_rx_skew;
}

bool qemu_eth_renew(void) {
    if (!s_netif) return false;
    esp_netif_dhcpc_stop(s_netif);
    return esp_netif_dhcpc_start(s_netif) == ESP_OK;
}
