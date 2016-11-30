# /bin/bash

set -e

# Ubuntu:
# sudo apt-get install texlive-full

pdflatex -shell-escape novel.tex
