# The donor image ships the shim that @cloudflare/sandbox's Files runs in the container.
# Keep its tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM python:3.13-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# pandas and numpy for data work; the rest are what skills' scripts commonly import (PDF, Excel, Word, PowerPoint,
# charts, images, YAML, templates, HTML/XML): the sandbox has no internet to install them at run time.
RUN pip install --no-cache-dir pandas==2.3.3 numpy==2.3.4 \
    pypdf==6.21.1 pdfplumber==0.11.10 reportlab==5.0.1 openpyxl==3.1.5 python-docx==1.2.0 python-pptx==1.0.2 \
    pillow==13.0.0 matplotlib==3.11.2 pyyaml==6.0.3 jinja2==3.1.6 beautifulsoup4==4.15.0 lxml==6.1.3 \
 && mkdir -p /workspace/files /workspace/skills /workspace/out /mnt/skills /mnt/user-data \
# Where skills written for another host look for their folder, their outputs and the user's uploads.
 && for kind in public user private examples; do ln -s /workspace/skills /mnt/skills/$kind; done \
 && ln -s /workspace/out /mnt/user-data/outputs \
 && ln -s /workspace/files /mnt/user-data/uploads
CMD ["sleep", "infinity"]
