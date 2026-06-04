---
title: Changelog
description: Recent Topchester changes grouped by day.
section: Reference
order: 5
public: true
---

# Changelog

Topchester changes grouped by day. This file is the source of truth for the public changelog.

## 2026-06-04

### Features

- Added TUI queued follow-up prompts, `/queue`, and `/steer` active-turn guidance.
- Added Codex device auth flow and global auth store ([28c0b17](https://github.com/kodi/topchester-agent/commit/28c0b17fb10c865d064944be39181ff21604b450))
- Added interactive restore command ([84e6f78](https://github.com/kodi/topchester-agent/commit/84e6f782aefb6f72ef7eb0da5c4655e6d4c6ea26))
- Added config validation and diagnostic summary command ([b91eb5a](https://github.com/kodi/topchester-agent/commit/b91eb5a44dcc05542526b0523e119aa5478d30c0))

### Fixes and polish

- Added colors to session picker date and id ([520526c](https://github.com/kodi/topchester-agent/commit/520526ce4d07b4095e1228e5225e4021fe84e20e))

### Docs and config

- Refine queued steering messages v0 plan with session and modal rules ([d29c19b](https://github.com/kodi/topchester-agent/commit/d29c19b499f8af3d7f68f26a947d1d0d88b4625d))
- Documented /fork command and added implementation plan ([a707103](https://github.com/kodi/topchester-agent/commit/a7071036376a4d40a8a64f8dbe8275e81d7b7f7c))
- Clarify hook action behaviors for block and stop ([db6c6bc](https://github.com/kodi/topchester-agent/commit/db6c6bc29e1bd9959e788f1f12e17595f3ea17b2))
- Migrate runtime configuration to JSONC-only ([d531660](https://github.com/kodi/topchester-agent/commit/d53166090bc7e02687c841665b78b58ab35c1b81))

### Releases

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
