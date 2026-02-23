from api.document_store import DocumentStore


def test_text_upload_and_context_building():
    store = DocumentStore()
    doc = store.add_document(
        session_id="s1",
        filename="note.txt",
        content_type="text/plain",
        content=b"Revenue growth was 18 percent. Risk includes infra cost.",
    )

    assert doc.file_id
    assert doc.session_id == "s1"
    assert len(doc.chunks) >= 1

    context = store.build_context("s1", [doc.file_id], "What was growth?")
    assert "18 percent" in context


def test_rejects_unsupported_extension():
    store = DocumentStore()
    try:
        store.add_document("s1", "malware.exe", "application/octet-stream", b"test")
        assert False, "expected ValueError"
    except ValueError as exc:
        assert str(exc) == "unsupported_file_type"
