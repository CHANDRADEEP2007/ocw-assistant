from api.ollama_client import OllamaClient


def test_circuit_open_blocks_requests():
    client = OllamaClient()
    client._circuit.state = "OPEN"
    client._circuit.opened_at = 9999999999

    assert client._allow_request() is False


def test_circuit_closes_after_success():
    client = OllamaClient()
    client._circuit.state = "HALF_OPEN"
    client._circuit.failure_count = 3
    client._record_success()

    assert client._circuit.state == "CLOSED"
    assert client._circuit.failure_count == 0
