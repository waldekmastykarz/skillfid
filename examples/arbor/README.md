# Arbor example

Arbor is a minimal smoke test for `skillfid`. Its corpus and skill contain one synthetic policy fact, keeping the model-backed workflow as small as possible.

From the repository root, build the dataset:

```sh
npm start -- dataset build \
	--corpus ./examples/arbor/corpus \
	--json
```

Use the returned dataset path to create a reusable baseline:

```sh
npm start -- eval baseline \
	--dataset ./datasets/<dataset-id> \
	--json
```

Evaluate the skill:

```sh
npm start -- eval run \
	--dataset ./datasets/<dataset-id> \
	--skill ./examples/arbor/skill \
	--json
```