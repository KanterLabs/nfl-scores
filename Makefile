.PHONY: install reload update check-live lint check package test-artifact artifact-cases render screenshots

install reload:
	./scripts/install.sh

update:
	./scripts/update.sh

check-live:
	node scripts/check-live.mjs

lint:
	for f in extension.js scoreboard.js games.js field.js draw.js capture.js; do node --check --input-type=module < $$f || exit 1; done
	glib-compile-schemas --strict --dry-run schemas

check:
	./ci/check

package:
	./ci/package

test-artifact: package
	./ci/test-artifact dist/nfl-scores@shanekanterman.shell-extension.zip

artifact-cases:
	./ci/test-artifact --self-test

render:
	gjs -m scripts/render-fixtures.js

screenshots:
	./scripts/screenshots.sh
