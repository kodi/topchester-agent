---
title: Changelog
description: Recent Topchester changes grouped by day.
section: Reference
order: 5
public: true
---

# Changelog

Topchester changes grouped by day. This file is the source of truth for the public changelog.

## 2026-08-15

### Features

- Added `topchester session debug` with event, tool, child-session, timing, coverage, and JSON diagnostics.
- Added session-scoped turn, model, tool, hook, approval, and setup timing records for reliable concurrent-session analysis.

## 2026-07-17

### Simplification

- Replaced the generated, embedded Topchester product-KB source with packaged static `topchester` skill references.
- Removed product-source CLI options, generated L1 resources, freshness tasks, and release-time resource regeneration.
- Kept project KB behavior focused on the current workspace and retained built-in skill checks in standalone packages.

## 2026-07-15

### Features

- Added version-matched, read-only Topchester product knowledge with automatic product-intent retrieval alongside project knowledge.
- Added the built-in `topchester` product-help skill and bounded `skill_read` access to linked skill files.
- Added `topchester kb sources`, `/kb sources`, and explicit `--source project|topchester|all` selection for KB search and context commands.

### Validation

- Added deterministic product-pack freshness and built-package content checks to local CI and publication validation.

## 2026-07-14

### Features

- Made TUI model and reasoning-effort selection session-scoped, with resume, restore, fork, and new-session lifecycle support.
- Added one selected config profile slot: `--config` now shadows `TOPCHESTER_CONFIG` instead of merging both files.
- Added the `max` reasoning effort supported by OpenRouter and GPT-5.6 Sol, Terra, and Luna across config, session overrides, slash commands, and provider requests.

### Fixes and polish

- Retained the selected config profile across runtime rebuilds, including providers defined only in `--config` or `TOPCHESTER_CONFIG`.
- Kept `/connect` provider provisioning separate from the current session's active model.

## 2026-07-08

### Features

- Added mention styling and range detection for file mentions in TUI input and rendered messages ([9e2c19d](https://github.com/kodi/topchester-agent/commit/9e2c19da11d72322370aad2bc105eed2553a8043)).
- Added TUI `@file` path autocomplete for workspace files and folders ([05882c2](https://github.com/kodi/topchester-agent/commit/05882c2415867879fd6603ce13fbc4093ffb7040)).
- Added `web_fetch` so the agent can read public HTTP(S) docs, changelogs, API references, issue pages, and package notes with private-network blocking, redirect visibility, size caps, and truncation markers ([58a591e](https://github.com/kodi/topchester-agent/commit/58a591e4ea8ad8a7d4abe3936522641e0e5a2026)).

### Releases

- Release topchester-ai v0.74.0 ([3fcaa8b](https://github.com/kodi/topchester-agent/commit/3fcaa8b95969337f0625c7c5350211b5008936be)).
- Release topchester-ai v0.73.0 ([cc84daf](https://github.com/kodi/topchester-agent/commit/cc84daffaf9dfc95e6d08ba83ac76cf8777fae57)).
- Release topchester-ai v0.72.0 ([c4139f6](https://github.com/kodi/topchester-agent/commit/c4139f650c9a084f912774dc9136cf428ab30988)).

## 2026-07-01

### Benchmarks

- Added more mini-bench tasks and improved CI environment handling for benchmark runs ([96a4cf2](https://github.com/kodi/topchester-agent/commit/96a4cf2c75bac84ef6d74d1ff2e93b7c2a1d2fc9)).

### Docs and config

- Added SanityHarness agent comparison follow-up planning notes ([c8deaeb](https://github.com/kodi/topchester-agent/commit/c8deaeb8bb2e1f1b76f85988b8d356be553e83eb)).

### Releases

- Release topchester-ai v0.71.0 ([7f49aaf](https://github.com/kodi/topchester-agent/commit/7f49aaf4c076fc64035c69bab42f3f2bcfca5468)).

## 2026-06-30

### Fixes and polish

- Avoided creating Docker Compose networks for no-service mini-bench tasks ([54dd12d](https://github.com/kodi/topchester-agent/commit/54dd12d37975e5b647d59cd7577067bda2faa085)).

### Docs and config

- Added Cursor Cloud setup notes to `AGENTS.md` ([605bd76](https://github.com/kodi/topchester-agent/commit/605bd76a590ecdb62e4c9f6cada8e202c0cff882)).

## 2026-06-17

### Features

- Restricted task subagents to read-only research tools so implementation changes stay with the primary agent ([fdabe0b](https://github.com/kodi/topchester-agent/commit/fdabe0b5f08f38f9f197c26e46fc24a04e7ef0df)).
- Added offset/limit reads and caching to the `read_file` tool ([814b2cb](https://github.com/kodi/topchester-agent/commit/814b2cbb331d75e8bfc38ef710e94b203f03a4de)).
- Added `max_tool_calls_per_turn` support and improved large-file read handling ([0da1746](https://github.com/kodi/topchester-agent/commit/0da17460765ccc7c024dfd940226d7fba656f0df)).
- Added `--benchmark-profile terminal-bench` for disposable benchmark containers ([4ff98a9](https://github.com/kodi/topchester-agent/commit/4ff98a9d07238f595902d6ee3fa8506a80549094)).

### Benchmarks

- Added the mini-bench local harness, reporting, and the first TypeScript transform task ([9934903](https://github.com/kodi/topchester-agent/commit/99349036bff3722e8ccc90b614d5a709723ae571)).
- Added sequential task runs, token usage, cost, and turn-count extraction to mini-bench reports ([55d9edf](https://github.com/kodi/topchester-agent/commit/55d9edfb7ec2e9c5784c121279ca7c6cd7637fc1), [14dc241](https://github.com/kodi/topchester-agent/commit/14dc241691c803e0dfa83df6dfd21a7c737ab377)).
- Added SQLite, JSON schema migrator, Postgres analytics, React todo panel, OpenRouter DeepSeek, and Gemini benchmark coverage ([dd544fa](https://github.com/kodi/topchester-agent/commit/dd544fa3c110d1564cc6319136c399069cfbc2a3), [7aa4daf](https://github.com/kodi/topchester-agent/commit/7aa4daf0fc2e562afd8320e5dae88b4121a4284a), [474ab0e](https://github.com/kodi/topchester-agent/commit/474ab0edfd374e7e43ed91ba74b2c6877e09bb78), [0e16ff8](https://github.com/kodi/topchester-agent/commit/0e16ff8aaaf86f96f9ffcec4aa1ee5376b5cd963), [ef87f10](https://github.com/kodi/topchester-agent/commit/ef87f10ba26c4f1bda9effa6d842d90da91bd336)).

### Fixes and polish

- Refined task tool instructions and fallback guidance for failed edits ([dc617dc](https://github.com/kodi/topchester-agent/commit/dc617dc1322a5994bea4ce698ace357c7d23c12a)).
- Scoped product tests away from benchmark fixture workspaces ([23c2c75](https://github.com/kodi/topchester-agent/commit/23c2c75b195da54442f7cc8a040489f72845c6cf)).

### Releases

- Release topchester-ai v0.70.0 ([7914351](https://github.com/kodi/topchester-agent/commit/791435190d48bfb3212ad66f21e4443fd57cfa08)).
- Release topchester-ai v0.69.0 ([812e754](https://github.com/kodi/topchester-agent/commit/812e7548baf5739adf17bf44d769c67892f0c5d7)).
- Release topchester-ai v0.68.0 ([14a1ba1](https://github.com/kodi/topchester-agent/commit/14a1ba14ae5a110c0f1ace430b8a20d17fdb5289)).
- Release topchester-ai v0.67.0 ([ac6d914](https://github.com/kodi/topchester-agent/commit/ac6d9148f2395af46085357c4e29bfd0647fb987)).

## 2026-06-12

### Features

- Added `--dangerously-auto-approve` for benchmark automation while recording auto-approved commands in session events ([52ec300](https://github.com/kodi/topchester-agent/commit/52ec300276fcdcd65773ff99912371460399a8fc)).
- Added KB inventory validation and configurable benchmark-agent options ([d6149e8](https://github.com/kodi/topchester-agent/commit/d6149e84641c2aa8fbff3749486cc30a78024228)).
- Added implementation-task validation with source mutation tracking ([69411c5](https://github.com/kodi/topchester-agent/commit/69411c56c2eb8b95e7527e8fe670ff04c60ce4b6)).
- Added `plan_todo` mode configuration and constraints ([136bfe4](https://github.com/kodi/topchester-agent/commit/136bfe4f43ebd82049978b5b640acdf3ab2229cb)).
- Replaced pnpm-wrapper benchmark execution with direct tool execution and added a required `finish_task` mode ([119cd44](https://github.com/kodi/topchester-agent/commit/119cd446f928776b1f4b20c1c542fd83c7c9a177)).

### Docs and config

- Added `topchester mcp add` command documentation ([dc99d62](https://github.com/kodi/topchester-agent/commit/dc99d6238ffe6de2e9320b50b66a3cda0421f6b1)).

### Releases

- Release topchester-ai v0.65.0 ([d8d0f84](https://github.com/kodi/topchester-agent/commit/d8d0f8412fb45c0f9cfd8bba37db0a077f425588)).
- Release topchester-ai v0.64.0 ([1156adc](https://github.com/kodi/topchester-agent/commit/1156adcc017106f5e8a23c5e792251f0eca93fc7)).
- Release topchester-ai v0.63.0 ([38492dc](https://github.com/kodi/topchester-agent/commit/38492dcdf58dfc1b22f8994f57924eed885d8c86)).
- Release topchester-ai v0.62.0 ([1036cc3](https://github.com/kodi/topchester-agent/commit/1036cc3adc2df895980706acb71c81199ecb42dd)).
- Release topchester-ai v0.61.0 ([207c12e](https://github.com/kodi/topchester-agent/commit/207c12e74be0c1fe51dfb7e8f3d29c016090db1d)).

## 2026-06-05

### Fixes and polish

- Removed integrations and hook stop commands that were superseded by the current command surface ([390eceb](https://github.com/kodi/topchester-agent/commit/390eceb29bfa8b1c00958378062723a6a6830942)).

## 2026-06-04

### Features

- Added reasoning effort configuration, `/effort` slash command support, autocomplete suggestions, and model-result logging for provider reasoning effort ([87e49e6](https://github.com/kodi/topchester-agent/commit/87e49e6e1e926918f79fa12f321ea732bdee2554), [f458974](https://github.com/kodi/topchester-agent/commit/f458974917753c06920584f32f4bb4dce4ea9d5c), [2869653](https://github.com/kodi/topchester-agent/commit/2869653ad688e5fa85ca940ef714efe323a238e3)).
- Added TUI queued follow-up prompts, `/queue`, and `/steer` active-turn guidance.
- Added `/effort` and `/reasoning` commands for durable provider reasoning effort.
- Added Codex device auth flow and global auth store ([28c0b17](https://github.com/kodi/topchester-agent/commit/28c0b17fb10c865d064944be39181ff21604b450))
- Added interactive restore command ([84e6f78](https://github.com/kodi/topchester-agent/commit/84e6f782aefb6f72ef7eb0da5c4655e6d4c6ea26))
- Added config validation and diagnostic summary command ([b91eb5a](https://github.com/kodi/topchester-agent/commit/b91eb5a44dcc05542526b0523e119aa5478d30c0))

### Fixes and polish

- Improved auth provider help, examples, and `topchester auth login` error guidance.
- Added colors to session picker date and id ([520526c](https://github.com/kodi/topchester-agent/commit/520526ce4d07b4095e1228e5225e4021fe84e20e))

### Docs and config

- Refine queued steering messages v0 plan with session and modal rules ([d29c19b](https://github.com/kodi/topchester-agent/commit/d29c19b499f8af3d7f68f26a947d1d0d88b4625d))
- Documented /fork command and added implementation plan ([a707103](https://github.com/kodi/topchester-agent/commit/a7071036376a4d40a8a64f8dbe8275e81d7b7f7c))
- Clarify hook action behaviors for block and stop ([db6c6bc](https://github.com/kodi/topchester-agent/commit/db6c6bc29e1bd9959e788f1f12e17595f3ea17b2))
- Migrate runtime configuration to JSONC-only ([d531660](https://github.com/kodi/topchester-agent/commit/d53166090bc7e02687c841665b78b58ab35c1b81))

### Releases

- Release topchester-ai v0.60.0 ([c5ff3ab](https://github.com/kodi/topchester-agent/commit/c5ff3abd742c7284e7e9bb27bc5f43b3b504c091)).
- Release topchester-ai v0.59.0 ([b0024e1](https://github.com/kodi/topchester-agent/commit/b0024e14ce7ddd194376fa721fb4959a42b5a324)).
- Release topchester-ai v0.58.0 ([faa5cad](https://github.com/kodi/topchester-agent/commit/faa5cad0320683974913e0be72a90207a7da11e5)).
- Release topchester-ai v0.57.0 ([a5fe758](https://github.com/kodi/topchester-agent/commit/a5fe758d042e213f51fe379c3af8f59a12499e58)).
- Release topchester-ai v0.56.0 ([8152224](https://github.com/kodi/topchester-agent/commit/81522240fd6e7ad40ec8ddd533a4c520f19c7f77))
- Release topchester-ai v0.55.0 ([9d7f372](https://github.com/kodi/topchester-agent/commit/9d7f372132cadf9e6973267fee148e4d6986274b))
- Release topchester-ai v0.54.0 ([5225a49](https://github.com/kodi/topchester-agent/commit/5225a496decc9d05b510c08127063f215edd0d26))
- Release topchester-ai v0.53.0 ([f6bceeb](https://github.com/kodi/topchester-agent/commit/f6bceeb8e548a3ad9aef2e8f1646db464494bdc0))
- Release topchester-ai v0.52.0 ([5a01f80](https://github.com/kodi/topchester-agent/commit/5a01f8084c9fd895a49d191b996e76869a2b66c7))
- Release topchester-ai v0.51.0 ([de8c0ca](https://github.com/kodi/topchester-agent/commit/de8c0cabdfe1dc8a140f95385ee194b3fa713a44))
- Release topchester-ai v0.50.0 ([a226660](https://github.com/kodi/topchester-agent/commit/a226660a5e2b1eb904359b0daf1ab0393f686991))
- Release topchester-ai v0.49.0 ([57ff726](https://github.com/kodi/topchester-agent/commit/57ff7261449589aec9642a0ffb36e7e027f9797c))
- Release topchester-ai v0.48.0 ([dea2810](https://github.com/kodi/topchester-agent/commit/dea2810908d90a8c433f4b4aef6c930d4c7577a7))
- Release topchester-ai v0.47.0 ([0801cd9](https://github.com/kodi/topchester-agent/commit/0801cd9792f90187146487c60ccce5a070689867))

## 2026-06-03

### Features

- Implemented local stdio MCP servers V0 ([e71cbb6](https://github.com/kodi/topchester-agent/commit/e71cbb6623345716f94bfc11f46683505b979883))
- Added includeUsage option to openai-compatible providers ([820d7c8](https://github.com/kodi/topchester-agent/commit/820d7c8dd1c20a7e977e6d0b08823a13298b7e50))
- Allow system messages in prompt input to suppress AI SDK warnings ([a530cb6](https://github.com/kodi/topchester-agent/commit/a530cb60c08c63f4be19263dcecd70443aa62932))
- Added prompt caching support for OpenAI-compatible providers ([0cc7648](https://github.com/kodi/topchester-agent/commit/0cc764839e042e611b5ced420e79b19d23de0f4d))
- Enhance tool call parsing and native tool repair ([ad2edcc](https://github.com/kodi/topchester-agent/commit/ad2edccbe3400e2f32661975d4c59624ab4a6b60))
- Support LiteLLM cost extraction from response headers ([015cf70](https://github.com/kodi/topchester-agent/commit/015cf70769fa214435e261a4cc57ca07bc8d2ac3))
- Added preview truncation for subagent messages ([8f0c597](https://github.com/kodi/topchester-agent/commit/8f0c597a148769824eb720bec8b774111d371e96))
- Improve model cost extraction and update docs ([b9877e1](https://github.com/kodi/topchester-agent/commit/b9877e19364b345730f517d61eb05e2b3577d226))

### Fixes and polish

- Restrict run_validator to read-only checks ([99c6de4](https://github.com/kodi/topchester-agent/commit/99c6de450e2fa22d3ed86748ad199ca4bbbe8261))
- Track current L1 entries correctly during incremental sync ([ba5a02d](https://github.com/kodi/topchester-agent/commit/ba5a02ded989563697f8a33f6586f2b9c5d7d04c))
- Use muted color for assistant message metadata ([929eae3](https://github.com/kodi/topchester-agent/commit/929eae312f21283beb913e8c426928e26f3695ce))

### Releases

- Release topchester-ai v0.46.0 ([2aa377f](https://github.com/kodi/topchester-agent/commit/2aa377f3df65dbc8307f624407717e35d950785b))
- Release topchester-ai v0.45.0 ([6214630](https://github.com/kodi/topchester-agent/commit/6214630f7abc2e29dd31b15991a87fca7d565c75))
- Release topchester-ai v0.44.0 ([7cacd53](https://github.com/kodi/topchester-agent/commit/7cacd5396eca299e643e913ee9c4ec4796a27df7))
- Release topchester-ai v0.43.0 ([b46acb7](https://github.com/kodi/topchester-agent/commit/b46acb7398f8210fd8123fcc67e8a78b8936cd2f))
- Release topchester-ai v0.42.0 ([7d9403e](https://github.com/kodi/topchester-agent/commit/7d9403e9efb9362a389aee606df3b02424886db3))
- Release topchester-ai v0.41.0 ([5472f5e](https://github.com/kodi/topchester-agent/commit/5472f5e14881dbf60a74bfd254931e402c76c6bf))
- Release topchester-ai v0.40.0 ([95f21b3](https://github.com/kodi/topchester-agent/commit/95f21b3e6c4daefcc2e277f78abd319cdc3f75b5))
- Release topchester-ai v0.39.0 ([6e77b9f](https://github.com/kodi/topchester-agent/commit/6e77b9f9660d3bf0ef2649d60647665ea6789315))
- Release topchester-ai v0.38.0 ([a46eb1c](https://github.com/kodi/topchester-agent/commit/a46eb1ca2badc17cbb594607fa490fe9473d5d4d))
- Release topchester-ai v0.37.0 ([b0e6f26](https://github.com/kodi/topchester-agent/commit/b0e6f26cbd727b341ad3d2385c25cc3025d6d0fb))
- Release topchester-ai v0.36.0 ([18bae72](https://github.com/kodi/topchester-agent/commit/18bae7258ad69ac0274e7a88731db82527f4f45a))
- Release topchester-ai v0.35.0 ([a8340f7](https://github.com/kodi/topchester-agent/commit/a8340f71e62ff8e028a52614a2bbf70754da4f2a))
- Release topchester-ai v0.34.0 ([9f385b2](https://github.com/kodi/topchester-agent/commit/9f385b236c89e9148c78bba79041b30f2b294d11))
- Release topchester-ai v0.33.0 ([cc34d1d](https://github.com/kodi/topchester-agent/commit/cc34d1d1f75332fd74dea9e5cb605c07338df978))

### Maintenance

- Merge docs intro into index ([6f8f5d9](https://github.com/kodi/topchester-agent/commit/6f8f5d9726bb0eec7d05e43da15c25c1121ccfc9))
- Added public docs source structure ([b549cd0](https://github.com/kodi/topchester-agent/commit/b549cd01d2181278cdf114797d2b7a0479f163a0))

## 2026-06-02

### Features

- Added line numbers to edit-file diff output ([d854c26](https://github.com/kodi/topchester-agent/commit/d854c262b13ecabdb73a79b779de24be413efdf9))
- Added --check option to update command ([3ada982](https://github.com/kodi/topchester-agent/commit/3ada9823b7b19ac17ead52c9cf335a18cf023293))
- Display unified diffs for file edits in TUI ([6ffe851](https://github.com/kodi/topchester-agent/commit/6ffe85117080e02070976b304a8cad9f68ac91fc))
- Added temporary expiring thread lines for hook status ([722a948](https://github.com/kodi/topchester-agent/commit/722a9488c11988e14ea0a847d965cac1567d1bd7))

### Fixes and polish

- Replace pipe with box-drawing character in diff output ([5048128](https://github.com/kodi/topchester-agent/commit/5048128b5f0586f10fbdc5b45543bd25636ef6c3))
- Correct typography in startup prompt hint ([ca7fc6d](https://github.com/kodi/topchester-agent/commit/ca7fc6da6c27bcc44619ada168dd700e63d8b902))
- Updated CLI entry point path in dev script and smoke tests ([85ebf28](https://github.com/kodi/topchester-agent/commit/85ebf28d83aad9f9662c4d0fe239bdc8de4325fa))
- Updated task plan TUI markers to use circular symbols ([76c1fc5](https://github.com/kodi/topchester-agent/commit/76c1fc52433554398b9fe60bc383ab8ad20e1495))

### Docs and config

- Fix typo in startup prompt hint ([d775d58](https://github.com/kodi/topchester-agent/commit/d775d58c65a5661019b0bc1041c42c8b27448244))
- Added scrolling to slash command suggestions ([0f1accf](https://github.com/kodi/topchester-agent/commit/0f1accfdd516700c064eff9983cd159ff395b259))

### Releases

- Release topchester-ai v0.32.0 ([8b0bd7f](https://github.com/kodi/topchester-agent/commit/8b0bd7f666261ce2fb54a9ac201d15d564424439))
- Release topchester-ai v0.31.0 ([ae362ff](https://github.com/kodi/topchester-agent/commit/ae362ff7a0d51ebbba0da29617da69e60217db0d))
- Release topchester-ai v0.30.0 ([8cbec54](https://github.com/kodi/topchester-agent/commit/8cbec54ed509e8d3572d58ab681a2d42c48a7a0d))
- Release topchester-ai v0.29.0 ([8a3e8d5](https://github.com/kodi/topchester-agent/commit/8a3e8d5918e5930e979d4cd0dcc104ad2a4b696a))
- Release topchester-ai v0.28.0 ([25b37bb](https://github.com/kodi/topchester-agent/commit/25b37bb9ad2185af09b03ddce0fcfcc955a001eb))

### Maintenance

- Sanitize diff output and improve CLI help layout ([9762b90](https://github.com/kodi/topchester-agent/commit/9762b902b16597c19077eea50e3cd72639ebd3fd))
- Updated job name and node version in code quality workflow ([0150c97](https://github.com/kodi/topchester-agent/commit/0150c97e00a5feceeb1c153b0c1736a2393ce165))
- Added typecheck step to code-quality workflow ([83c0750](https://github.com/kodi/topchester-agent/commit/83c0750f5a303ec1fc150643ec4398fb3a87789c))
- Refactor CLI entry point to a dedicated bin shim ([980bb7e](https://github.com/kodi/topchester-agent/commit/980bb7e004328115b6475b211f3c1d9bba629c4e))
- Extract CLI program creation and enable programmatic execution ([c659346](https://github.com/kodi/topchester-agent/commit/c6593465c409fe04274d46b9b2fa29a19fd9a792))
- Added commands ([769acf5](https://github.com/kodi/topchester-agent/commit/769acf5267d60f4aaa4f45a9e964b35e1ce9ebb8))

## 2026-06-01

### Features

- Added text wrapping and truncation for chat modals ([d0e0576](https://github.com/kodi/topchester-agent/commit/d0e057621f3e79ceec8fca2f739713137d3c05e4))

### Docs and config

- Rename run_command to bash and update permission model ([ef5a62d](https://github.com/kodi/topchester-agent/commit/ef5a62d8ff893ccd5a62fd0b31a38631e64b57ee))

### Releases

- Release topchester-ai v0.27.0 ([b9aaae9](https://github.com/kodi/topchester-agent/commit/b9aaae99e08434810de2a3ab7be83bae1aaab604))

## 2026-05-31

### Features

- Added agent registry and metadata system ([4b61af0](https://github.com/kodi/topchester-agent/commit/4b61af0fd38e90fcd542bfcc4130cf8584689008))

### Releases

- Release topchester-ai v0.26.0 ([c97dc1c](https://github.com/kodi/topchester-agent/commit/c97dc1c1d03a1a3f0136a2529bfaa5616582b64e))
