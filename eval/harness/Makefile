IMAGE := contextnest-eval:latest
WORKDIR := /workspace

DOCKER_RUN := docker run --rm -it \
	-v $(PWD):$(WORKDIR) \
	-v $(PWD)/vaults:$(WORKDIR)/vaults \
	-v $(PWD)/outputs:$(WORKDIR)/outputs \
	--env-file .env \
	-w $(WORKDIR) \
	$(IMAGE)

NEST ?= $(HOME)/Development/mybrain/vault
N ?= 12

.PHONY: build shell ctx clean rebuild env ragas retrieval bakeoff

build:
	docker build --network=host -t $(IMAGE) .

rebuild:
	docker build --network=host --no-cache -t $(IMAGE) .

env:
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example — fill in ANTHROPIC_API_KEY.")

shell: env
	$(DOCKER_RUN)

ctx: env
	$(DOCKER_RUN) ctx $(ARGS)

run: env
	$(DOCKER_RUN) python run.py

# RAGAS 4-arm head-to-head over the real brain (mounted read-only).
# Usage: make ragas N=12 NEST=/path/to/vault
ragas: env
	docker run --rm \
		-v $(PWD):$(WORKDIR) \
		-v $(NEST):$(WORKDIR)/nest:ro \
		-v $(PWD)/outputs:$(WORKDIR)/outputs \
		-v $(PWD)/.hf-cache:/root/.cache \
		--env-file .env \
		-e VAULT_DIR=$(WORKDIR)/nest \
		-e N_QUESTIONS=$(N) \
		-w $(WORKDIR) \
		$(IMAGE) python run_ragas.py

# Flavor A — retrieval-only bake-off (ctx_search vs bm25 vs dense), no judge.
# Usage: make retrieval N=50
retrieval: env
	docker run --rm \
		-v $(PWD):$(WORKDIR) \
		-v $(NEST):$(WORKDIR)/nest:ro \
		-v $(PWD)/outputs:$(WORKDIR)/outputs \
		-v $(PWD)/.hf-cache:/root/.cache \
		--env-file .env \
		-e VAULT_DIR=$(WORKDIR)/nest \
		-e N_QUESTIONS=$(N) \
		-w $(WORKDIR) \
		$(IMAGE) python run_retrieval.py

# Flavor B — end-to-end answer quality, governance held constant (fair 3 arms).
bakeoff: env
	docker run --rm \
		-v $(PWD):$(WORKDIR) \
		-v $(NEST):$(WORKDIR)/nest:ro \
		-v $(PWD)/outputs:$(WORKDIR)/outputs \
		-v $(PWD)/.hf-cache:/root/.cache \
		--env-file .env \
		-e VAULT_DIR=$(WORKDIR)/nest \
		-e N_QUESTIONS=$(N) \
		-e ARMS=ctx_search,bm25_clean,dense \
		-e OUTPUT_PREFIX=bakeoff \
		-w $(WORKDIR) \
		$(IMAGE) python run_ragas.py

clean:
	docker rmi $(IMAGE) || true
