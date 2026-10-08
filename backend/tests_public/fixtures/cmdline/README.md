Command lines of a fenced main `claude`, one argument per line, recorded in the tm-sbmain spike
(shots/v2/evidence/cmdline-*.txt) with the home and checkout paths renamed, main's appended prompt and its
`--agents` definition shortened, and the entry of a plugin thimble no longer ships dropped from `enabledPlugins`. `test_cc_plugin.py` reads them for `cc_plugin.main_fenced`.

- fenced-main.txt: a main started with the spike's `--agents`;
- first-launch-no-agents.txt: a main started without one (also what the plugin-agent variant recorded).
