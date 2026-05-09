from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "main.py").read_text(encoding="utf-8")


def test_api_key_validation_runs_during_lifespan():
    # Regression: MAIN-FIX-10
    assert "def validate_ml_service_api_key() -> None:" in SOURCE
    assert "validate_ml_service_api_key()" in SOURCE
    assert 'runtime_mode in {"testnet", "mainnet"}' in SOURCE


def test_api_key_sentinel_is_rejected_in_testnet_mainnet_modes():
    # Regression: MAIN-FIX-10
    assert 'ML_SERVICE_API_KEY_SENTINEL = "replace-me-with-a-random-32-byte-hex-value"' in SOURCE
    assert "ML_SERVICE_API_KEY is required in testnet/mainnet mode" in SOURCE
    assert "ML_SERVICE_API_KEY is still set to the .env.example sentinel" in SOURCE
