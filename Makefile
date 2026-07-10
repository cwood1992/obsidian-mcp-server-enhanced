# Product targets for the ChatGPT facade. Run via Git Bash / WSL on Windows.

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
