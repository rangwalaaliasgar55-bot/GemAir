#!/bin/bash
while true; do
  node agent.js
  echo "Agent crashed. Restarting in 5..."
  sleep 5
done
chmod +x start-agent.sh
nohup ./start-agent.sh > agent.log 2>&1 &
