# Tropy.md plugin — dev helpers
#
# Common workflow:
#
#   1. make dev-zip                       (build a dev-named zip)
#   2. install build/tropymd-dev.zip via Tropy → Preferences → Plugins
#   3. make link                          (replace installed index.js with
#                                          a symlink to your working copy)
#   4. edit index.js, reload Tropy        (no rebuild needed)
#   5. make zip                           (build the release zip when done)
#
# Tag a release on GitHub with `git tag v$(VERSION) && git push --tags` to
# get the release workflow to attach the install zip automatically.

NAME       := tropymd
VERSION    := $(shell node -p "require('./package.json').version")
PKG_FILES  := index.js package.json icon.svg LICENSE README.md

# Tropy's plugin directory. Override on the command line if needed:
#   make link TROPY_PLUGIN_DIR=/some/other/path
TROPY_PLUGIN_DIR ?= $(HOME)/Library/Application Support/Tropy/plugins
DEV_PLUGIN := $(TROPY_PLUGIN_DIR)/$(NAME)-dev

.PHONY: help zip dev-zip link unlink clean

help:
	@echo "Tropy.md make targets:"
	@echo ""
	@echo "  make zip       Build build/$(NAME)-v$(VERSION).zip (release-shaped)"
	@echo "  make dev-zip   Build build/$(NAME)-dev.zip — installs as a"
	@echo "                 second plugin ('Tropy.md (dev)') alongside the"
	@echo "                 release, so you can keep both side-by-side"
	@echo "  make link      After installing dev-zip via Tropy, replace the"
	@echo "                 installed index.js with a symlink to this repo's"
	@echo "                 index.js. Edit + reload Tropy to iterate."
	@echo "  make unlink    Remove the symlink and restore the original."
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

link:
	@if [ ! -d "$(DEV_PLUGIN)" ]; then \
	  echo "Tropy hasn't installed $(NAME)-dev yet."; \
	  echo "Run 'make dev-zip' and install build/$(NAME)-dev.zip via Tropy first."; \
	  exit 1; \
	fi
	@if [ ! -L "$(DEV_PLUGIN)/index.js" ] && [ -f "$(DEV_PLUGIN)/index.js" ]; then \
	  cp "$(DEV_PLUGIN)/index.js" "$(DEV_PLUGIN)/index.js.installed"; \
	fi
	@ln -sf "$(CURDIR)/index.js" "$(DEV_PLUGIN)/index.js"
	@echo "Linked $(DEV_PLUGIN)/index.js -> $(CURDIR)/index.js"
	@echo "Reload your Tropy project window to pick up changes."

unlink:
	@if [ -L "$(DEV_PLUGIN)/index.js" ]; then rm "$(DEV_PLUGIN)/index.js"; fi
	@if [ -f "$(DEV_PLUGIN)/index.js.installed" ]; then \
	  mv "$(DEV_PLUGIN)/index.js.installed" "$(DEV_PLUGIN)/index.js"; \
	  echo "Restored installed index.js."; \
	else \
	  echo "No backup found — reinstall the plugin to restore index.js."; \
	fi

clean:
	@rm -rf build/
	@echo "Cleaned build/"
