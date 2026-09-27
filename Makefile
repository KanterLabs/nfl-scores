.PHONY: install reload update check-live lint render screenshots

install reload:
	./scripts/install.sh

update:
	./scripts/update.sh

check-live:
	node scripts/check-live.mjs

lint:
	for f in extension.js scoreboard.js games.js field.js draw.js capture.js; do node --check --input-type=module < $$f || exit 1; done
	glib-compile-schemas --strict --dry-run schemas

render:
	gjs -m scripts/render-fixtures.js

screenshots:
	./scripts/screenshots.sh
