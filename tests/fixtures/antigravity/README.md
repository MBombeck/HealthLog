# Antigravity CLI Test Fixtures

This directory contains synthetic test data for Antigravity CLI multimodal testing.

**IMPORTANT**: All documents here are SYNTHETIC and contain NO real medical data.

## Document Types

- `synthetic-single-page.pdf` - Single page synthetic PDF
- `synthetic-multi-page.pdf` - Multi-page synthetic PDF (10 pages)
- `synthetic-lab-results.pdf` - Synthetic laboratory results with biomarkers
- `synthetic-scan.pdf` - Simulated scanned document (low quality)

## Test Coverage

These fixtures cover Stage 3 multimodal requirements:

1. Single and multi-page PDFs
2. Text layer vs scanned documents
3. Laboratory tables with biomarkers, units, reference ranges
4. Decimal separators (comma vs dot)
5. Low-quality images
6. Damaged/unusual documents
7. Document length limits

## Generation

All PDFs are generated programmatically using a PDF library and contain ONLY synthetic data:

- No real patient names
- No real medical record numbers
- No real dates
- No real laboratory values

DO NOT add real medical documents to this directory.
