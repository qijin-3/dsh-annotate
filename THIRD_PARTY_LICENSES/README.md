# Third-party licenses

`lib/inject.js` is a prebuilt bundle. It contains the following unmodified
third-party code:

| Package | Version | License | File |
| --- | --- | --- | --- |
| agentation | 3.1.2 | PolyForm Shield 1.0.0 | `agentation-LICENSE.txt` |
| react | 18.3.1 | MIT | `react-LICENSE.txt` |
| react-dom | 18.3.1 | MIT | `react-dom-LICENSE.txt` |
| scheduler | 0.23.2 | MIT | `scheduler-LICENSE.txt` |

The plugin's own code (everything outside `lib/inject.js`) is MIT; see the
repository's `LICENSE`.

agentation is source-available under PolyForm Shield, not OSI open source.
That license permits use except for competing with agentation; review it
before commercial redistribution. The plugin does not modify agentation's
source; it bundles the published npm artifact and adds a submit bridge.
