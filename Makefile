# Tropy.md plugin — dev helpers

NAME       := tropymd
VERSION    := $(shell node -p "require('./package.json').version")
PKG_FILES  := index.js package.json icon.svg LICENSE README.md

# Tropy's plugin directory.
TROPY_PLUGIN_DIR ?= $(HOME)/Library/Application Support/Tropy/plugins
DEV_PLUGIN := $(TROPY_PLUGIN_DIR)/$(NAME)-dev

.PHONY: help zip dev-zip clean

help:
	@echo "Tropy.md make targets:"
	@echo ""
	@echo "  make zip       Build build/$(NAME)-v$(VERSION).zip (release-shaped)"
	@echo "  make dev-zip   Build build/$(NAME)-dev.zip — installs as a"
	@echo "                 second plugin ('Tropy.md (dev)') alongside the"
	@echo "                 release, so you can keep both side-by-side"
	@echo "  make clean     Remove build/"

zip:
	@rm -rf "build/$(NAME)-v$(VERSION)" "build/$(NAME)-v$(VERSION).zip"
	@mkdir -p "build/$(NAME)-v$(VERSION)"
	@cp $(PKG_FILES) "build/$(NAME)-v$(VERSION)/"
	@cd build && zip -qr "$(NAME)-v$(VERSION).zip" "$(NAME)-v$(VERSION)"
	@echo "Built build/$(NAME)-v$(VERSION).zip"

dev-zip:
	@rm -rf "build/$(NAME)-dev" "build/$(NAME)-dev.zip"
	@mkdir -p "build/$(NAME)-dev"
	@cp index.js icon.svg LICENSE README.md "build/$(NAME)-dev/"
	@node -e "const p = require('./package.json'); \
	  p.name = '$(NAME)-dev'; \
	  p.productName = 'Tropy.md (dev)'; \
	  require('fs').writeFileSync('build/$(NAME)-dev/package.json', \
	    JSON.stringify(p, null, 2) + '\n')"
	@cd build && zip -qr "$(NAME)-dev.zip" "$(NAME)-dev"
	@echo "Built build/$(NAME)-dev.zip — installs as 'Tropy.md (dev)'"

clean:
	@rm -rf build/
	@echo "Cleaned build/"
