#!/bin/bash
# scp -r -P 22 ciprian@192.168.1.167:/home/ciprian/workspace/live/dex-trader/watcher-v2/data/logs ./live_logs
rsync -avz -e "ssh -p 22" ciprian@192.168.1.167:/home/ciprian/workspace/projects/universal-trader/watcher/data/logs ./live_logs