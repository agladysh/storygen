# /bin/bash

set -e

# Ubuntu:
# sudo apt-get install texlive-full

xelatex -shell-escape novel.tex
