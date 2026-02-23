.PHONY: dev test smoke stress audit

dev:
	bash scripts/dev.sh

test:
	bash scripts/test.sh

smoke:
	bash scripts/smoke_e2e.sh

stress:
	bash scripts/stress.sh

audit:
	bash scripts/audit.sh
