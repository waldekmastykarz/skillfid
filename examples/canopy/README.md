# Canopy product demo

Canopy is an original, synthetic distributed build cache used to demonstrate the complete `skillfid` workflow. Its corpus contains precise policies, thresholds, exceptions, and operating procedures that are not part of a model's general knowledge.

The original `skill/` is intentionally compressed, leaving some source details absent or less explicit. The revised `skill-v2/` applies the source-backed findings from that evaluation without encoding the generated questions. Together they provide a before-and-after example of evaluating and improving a skill.

A calibrated dataset is included at `dataset/ds_7f1bc4dc92fc4b51`. Verify it
from the repository root without making model calls:

```sh
npm start -- dataset verify \
	--dataset ./examples/canopy/dataset/ds_7f1bc4dc92fc4b51
```

To reproduce the dataset from the Canopy corpus, run:

```sh
npm start -- dataset build \
	--corpus ./examples/canopy/corpus \
	--output-dir ./examples/canopy/dataset \
	--work-dir ./.work/canopy-dataset \
	--json
```

A compatible closed-book baseline is included in `baselines/`. To reproduce it,
run:

```sh
npm start -- eval baseline \
	--dataset ./examples/canopy/dataset/ds_7f1bc4dc92fc4b51 \
	--output-dir ./examples/canopy/baselines \
	--work-dir ./.work/canopy-baseline \
	--json
```

Evaluate the original skill with explicit invocation:

```sh
npm start -- eval run \
	--dataset ./examples/canopy/dataset/ds_7f1bc4dc92fc4b51 \
	--skill ./examples/canopy/skill \
	--baseline-dir ./examples/canopy/baselines \
	--skill-invocation explicit \
	--json
```

Evaluate skill v2 against the same baseline:

```sh
npm start -- eval run \
	--dataset ./examples/canopy/dataset/ds_7f1bc4dc92fc4b51 \
	--skill ./examples/canopy/skill-v2 \
	--baseline-dir ./examples/canopy/baselines \
	--skill-invocation explicit \
	--json
```

Generate a self-contained report from the returned run path:

```sh
npm start -- eval report \
	--run ./runs/<run-id> \
	--dataset ./examples/canopy/dataset/ds_7f1bc4dc92fc4b51 \
	--title "Canopy cache operations"
```