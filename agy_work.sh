#!/usr/bin/env bash
# agy_work.sh <session_name> <cwd> <prompt>
#
# Spawn an agy tmux session, force the model to Gemini 3.8 Flash (Medium) using
# the /model dialog's own Search box, then hand it the task.
#
# Why: agy's DEFAULT model drifts (came up on Gemini 3.6 Flash on 2026-10-11), and
# the owner requires gemini 3.8 flash medium and nothing else. This script does not
# send the task until the status bar reads exactly "Gemini 3.8 Flash · medium",
# and ABORTS otherwise — a guard that can actually fail.
set -uo pipefail
NAME="$1"; CWD="$2"; PROMPT="$3"
AGY=/home/roni-saguey/.local/bin/agy
WANT="Gemini 3.8 Flash · medium"

bar()  { tmux capture-pane -t "$NAME" -p -S -12 2>/dev/null | grep -oE '(Gemini|Claude|GPT-OSS)[^·]*· *[a-z]+' | tail -1; }
pane() { tmux capture-pane -t "$NAME" -p -S -30 2>/dev/null; }

tmux kill-session -t "$NAME" 2>/dev/null
tmux new-session -d -s "$NAME" -c "$CWD" "$AGY --dangerously-skip-permissions" >/dev/null || exit 4
sleep 10

# trust prompt for a new cwd (default row = "Yes, I trust this folder")
if pane | grep -q "Do you trust the contents"; then tmux send-keys -t "$NAME" Enter; sleep 3; fi
# first-run dialogs
for i in 1 2 3; do
  if pane | grep -q "esc to dismiss"; then tmux send-keys -t "$NAME" Escape; sleep 1.5; fi
done
sleep 2

# ---- force the model: /model -> search "3.8" -> effort medium -> Enter --------
tmux send-keys -t "$NAME" "/model"; sleep 1
tmux send-keys -t "$NAME" Enter; sleep 4
tmux send-keys -t "$NAME" -l "3.8"; sleep 2          # Search box filters to the one row
tmux send-keys -t "$NAME" Left;  sleep 0.3            # clamp effort low
tmux send-keys -t "$NAME" Left;  sleep 0.3
tmux send-keys -t "$NAME" Left;  sleep 0.3
tmux send-keys -t "$NAME" Right; sleep 1              # step to medium
tmux send-keys -t "$NAME" Enter; sleep 4

# ---- HARD GUARD ---------------------------------------------------------------
got="$(bar)"
if [ "$got" != "$WANT" ]; then
  echo "ABORT $NAME: model is '${got:-unknown}', want '$WANT' — not sending the task" >&2
  exit 3
fi

tmux send-keys -t "$NAME" -l "$PROMPT"
tmux send-keys -t "$NAME" Enter
echo "spawned $NAME [$got] in $CWD"
