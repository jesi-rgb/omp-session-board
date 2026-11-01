# omp-session-board

opencode-style session switching for [omp](https://github.com/can1357/oh-my-pi), backed by tmux.

Each omp process runs one session; sessions you are not looking at live in a detached tmux session named `omp-pool` and keep running.

| Key | Action |
| --- | --- |
| `Ctrl+X L` / `/board` | Session switcher: Done, Working, Saved (Tab toggles saved, typing filters). Enter opens, Ctrl+N new, Esc closes. |
| `Ctrl+X N` | New session in the current directory, swapped into this pane. |

## Requirements

- omp
- tmux (run omp inside a tmux pane)

## Install

```sh
omp plugin install github:jesi-rgb/omp-session-board
```

Update to the latest commit:

```sh
omp plugin upgrade omp-session-board
```
