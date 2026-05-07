# Third-Party Notices

This project was informed by the design and implementation approaches of the following open-source repositories:

## Referenced Projects

### tim-smart/actualbudget-sync
- Repository: [https://github.com/tim-smart/actualbudget-sync](https://github.com/tim-smart/actualbudget-sync)
- License: MIT
- Local reference copies outside this repo were used during development.

Used as a reference for:
- Actual client version-matching strategy
- Transaction reconciliation patterns
- Category and transfer-oriented sync behavior

### redbark-co/actual-sync
- Repository: [https://github.com/redbark-co/actual-sync](https://github.com/redbark-co/actual-sync)
- License: MIT
- Local reference copies outside this repo were used during development.

Used as a reference for:
- Actual API version compatibility handling
- Operational patterns around loading a matching `@actual-app/api` version

## Notes

- This repository does not vendor those projects or redistribute them as bundled dependencies.
- Any code that was influenced by those projects has been adapted to this project’s architecture and data model.
- The original copyright and license terms for those projects remain with their respective authors.
