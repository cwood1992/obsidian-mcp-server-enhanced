# Target-owned bridge for repo-contract-kit commands.
#
# Keep product-specific targets in this Makefile. The installed kit command
# surface lives in .doc-contract-kit/make/repo-contract.mk and is updated by
# `kit update`.

include .doc-contract-kit/make/repo-contract.mk

.PHONY: chatgpt-facade chatgpt-facade-health tailscale-funnel-chatgpt tailscale-funnel-chatgpt-disable

CHATGPT_FACADE_TARGET ?= http://127.0.0.1:3020
CHATGPT_FACADE_HTTPS_PORT ?= 443

chatgpt-facade:
	npm run start:chatgpt

chatgpt-facade-health:
	curl -fsS "$(CHATGPT_FACADE_TARGET)/health"

tailscale-funnel-chatgpt:
	tailscale funnel --bg --https=$(CHATGPT_FACADE_HTTPS_PORT) --yes $(CHATGPT_FACADE_TARGET)

tailscale-funnel-chatgpt-disable:
	tailscale funnel --https=$(CHATGPT_FACADE_HTTPS_PORT) off
