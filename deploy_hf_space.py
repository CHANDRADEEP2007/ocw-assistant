import argparse
import os

from huggingface_hub import HfApi


def main() -> None:
    parser = argparse.ArgumentParser(description="Deploy project to a Hugging Face Space")
    parser.add_argument("--repo-id", required=True, help="Format: username/space_name")
    parser.add_argument("--token", default=os.getenv("HF_TOKEN", ""), help="Hugging Face token")
    parser.add_argument("--private", action="store_true", help="Create private space")
    args = parser.parse_args()

    if not args.token:
        raise SystemExit("Missing token. Pass --token or set HF_TOKEN.")

    api = HfApi(token=args.token)

    api.create_repo(
        repo_id=args.repo_id,
        repo_type="space",
        space_sdk="gradio",
        private=args.private,
        exist_ok=True,
    )

    api.upload_folder(
        repo_id=args.repo_id,
        repo_type="space",
        folder_path=".",
        ignore_patterns=[
            ".env",
            ".venv/*",
            "__pycache__/*",
            ".pytest_cache/*",
            "*.pyc",
            "tests/*",
            "README_SPACE.md",
        ],
    )

    print(f"Uploaded to https://huggingface.co/spaces/{args.repo_id}")


if __name__ == "__main__":
    main()
