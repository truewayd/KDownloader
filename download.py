import argparse
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_SITE = "https://coomerfans.com"
DEFAULT_TIMEOUT = 20
DOWNLOAD_API_URL = "http://127.0.0.1:15151/start-headless-download"


def build_session() -> requests.Session:
    """Create a requests session with retries and browser-like headers."""
    session = requests.Session()
    retry = Retry(
        total=5,
        backoff_factor=0.6,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "HEAD", "POST"]),
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        }
    )
    return session


def absolute_url(href: str) -> str:
    return urljoin(BASE_SITE, href)


def parse_profile_url(profile_url: str) -> tuple[str, str, str]:
    parsed = urlparse(profile_url.strip())
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 4 or parts[0] != "u":
        raise ValueError("Invalid profile URL path format.")

    platform, performer_id, performer_slug = parts[1], parts[2], parts[3]
    if platform not in {"onlyfans", "fansly"}:
        raise ValueError("Platform in URL must be onlyfans or fansly.")
    if not performer_id:
        raise ValueError("Performer ID missing in URL.")
    if not performer_slug:
        raise ValueError("Performer slug missing in URL.")
    return platform, performer_id, performer_slug


def discover_post_urls(
    session: requests.Session,
    platform: str,
    performer_id: str,
    performer_slug: str,
    max_pages: int,
) -> list[str]:
    post_urls: list[str] = []
    seen = set()

    for page_idx in range(1, max_pages + 1):
        base_profile = f"{BASE_SITE}/u/{platform}/{performer_id}/{performer_slug}"
        list_urls = [base_profile] if page_idx == 1 else []
        list_urls.append(f"{base_profile}?page={page_idx}")
        list_urls.append(f"{base_profile}?o={(page_idx - 1) * 50}")

        response = None
        for list_url in list_urls:
            try:
                candidate = session.get(list_url, timeout=DEFAULT_TIMEOUT)
                candidate.raise_for_status()
                response = candidate
                break
            except requests.RequestException:
                continue

        if response is None:
            print(f"[warn] Failed to fetch listing page {page_idx}")
            continue

        soup = BeautifulSoup(response.text, "html.parser")
        found_this_page = 0
        for link in soup.find_all("a", href=True):
            href = link["href"]
            if (
                f"/p/" in href
                and f"/{performer_id}/{platform}" in href
            ) or (f"/{platform}/user/{performer_id}/post/" in href):
                full = absolute_url(href)
                if full not in seen:
                    seen.add(full)
                    post_urls.append(full)
                    found_this_page += 1

        print(f"[info] Page {page_idx}: found {found_this_page} new posts")
        if found_this_page == 0:
            break

    return post_urls


def extract_media_urls_from_post(
    session: requests.Session, post_url: str
) -> list[str]:
    try:
        response = session.get(post_url, timeout=DEFAULT_TIMEOUT)
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"[warn] Failed to fetch post {post_url}: {exc}")
        return []

    soup = BeautifulSoup(response.text, "html.parser")
    urls = set()

    selectors = [
        "video source[src]",
        "video[src]",
        "a.fileThumb[href]",
        "a[href]",
        "img[src]",
        "img[data-src]",
        "img[data-original]",
        "img[data-lazy-src]",
    ]
    for tag in soup.select(", ".join(selectors)):
        value = (
            tag.get("src")
            or tag.get("href")
            or tag.get("data-src")
            or tag.get("data-original")
            or tag.get("data-lazy-src")
        )
        if not value:
            continue
        full = absolute_url(value)
        if is_relevant_media_url(full):
            urls.add(full)

    return sorted(urls)


def filename_from_url(url: str, fallback_name: str) -> str:
    name = Path(urlparse(url).path).name
    return name or fallback_name


def post_id_from_post_url(post_url: str) -> str:
    parts = [part for part in urlparse(post_url).path.split("/") if part]
    if len(parts) >= 2 and parts[0] == "p":
        return parts[1]
    return "unknown_post"


def extension_from_media_url(media_url: str) -> str:
    ext = Path(urlparse(media_url).path).suffix.lower()
    return ext if ext else ".bin"


def is_video_url(media_url: str) -> bool:
    return extension_from_media_url(media_url) in {".mp4", ".webm", ".m4v", ".mov"}


def is_image_url(media_url: str) -> bool:
    return extension_from_media_url(media_url) in {".jpg", ".jpeg", ".png", ".gif", ".webp"}


def is_relevant_media_url(media_url: str) -> bool:
    parsed = urlparse(media_url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    ext = extension_from_media_url(media_url)

    allowed_exts = {
        ".mp4",
        ".webm",
        ".m4v",
        ".mov",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".zip",
        ".rar",
        ".7z",
    }
    if ext not in allowed_exts:
        return False

    if "/istorage/" in path:
        return False

    if "/storage/" in path and "coomerfans.com" in host:
        return True

    return False


def build_output_filename(
    performer_slug: str, post_id: str, media_url: str, post_media_index: int
) -> str:
    ext = extension_from_media_url(media_url)
    suffix = "" if post_media_index == 1 else f".{post_media_index}"
    return f"{performer_slug}.{post_id}{suffix}{ext}"


def send_download_request(
    session: requests.Session,
    url: str,
    file_name: str,
    index: int,
    total: int,
) -> str:
    """Send download task to local downloader API instead of saving locally."""
    payload = {
        "downloadSource": {
            "link": url
        },
        "name": file_name,
        "queueId": 0
    }

    print(f"[{index}/{total}] Sending to local API: {file_name} ... ", end="", flush=True)

    try:
        response = session.post(DOWNLOAD_API_URL, json=payload, timeout=DEFAULT_TIMEOUT)
        response.raise_for_status()
        print("[OK]")
        return "downloaded"
    except requests.RequestException as exc:
        print(f"[FAIL] {exc}")
        return "failed"


def run(
    platform: str,
    performer_id: str,
    performer_slug: str,
    max_pages: int,
    dry_run: bool,
    content_mode: str,
    limit: int | None,
) -> None:
    session = build_session()

    post_urls = discover_post_urls(
        session=session,
        platform=platform,
        performer_id=performer_id,
        performer_slug=performer_slug,
        max_pages=max_pages,
    )
    if not post_urls:
        print("[info] No posts found.")
        return

    print(f"[info] Discovered {len(post_urls)} posts. Extracting media links...")
    media_items: list[tuple[str, str]] = []
    seen = set()
    for post_index, post_url in enumerate(post_urls, start=1):
        post_media_urls = extract_media_urls_from_post(session, post_url)
        new_from_post = 0
        for media_url in post_media_urls:
            if media_url not in seen:
                seen.add(media_url)
                media_items.append((post_url, media_url))
                new_from_post += 1
        print(
            f"[extract] {post_index}/{len(post_urls)} "
            f"post={post_id_from_post_url(post_url)} "
            f"new={new_from_post} total_unique={len(media_items)}"
        )

    if not media_items:
        print("[info] No media files found in discovered posts.")
        return

    if content_mode == "videos":
        media_items = [
            (post_url, media_url)
            for post_url, media_url in media_items
            if is_video_url(media_url)
        ]
        print(f"[info] Filtered to {len(media_items)} video files (--content-mode videos).")
        if not media_items:
            print("[info] No video files matched.")
            return
    elif content_mode == "images":
        media_items = [
            (post_url, media_url)
            for post_url, media_url in media_items
            if is_image_url(media_url)
        ]
        print(f"[info] Filtered to {len(media_items)} image files (--content-mode images).")
        if not media_items:
            print("[info] No image files matched.")
            return

    if limit is not None and limit > 0:
        media_items = media_items[:limit]
        print(f"[info] Limited to first {len(media_items)} files (--limit).")

    print(f"[info] Found {len(media_items)} unique media files.")
    if dry_run:
        print("[dry-run] No requests were sent.")
        for idx, (post_url, media_url) in enumerate(media_items[:10], start=1):
            print(
                f"[dry-run] {idx:>2}: post={post_id_from_post_url(post_url)} "
                f"url={media_url}"
            )
        if len(media_items) > 10:
            print(f"[dry-run] ...and {len(media_items) - 10} more")
        return

    success = 0
    failed = 0
    post_media_counts: dict[str, int] = {}
    
    for idx, (post_url, media_url) in enumerate(media_items, start=1):
        post_id = post_id_from_post_url(post_url)
        post_media_counts[post_id] = post_media_counts.get(post_id, 0) + 1
        post_media_index = post_media_counts[post_id]

        output_name = build_output_filename(
            performer_slug=performer_slug,
            post_id=post_id,
            media_url=media_url,
            post_media_index=post_media_index,
        )
        
        status = send_download_request(
            session=session,
            url=media_url,
            file_name=output_name,
            index=idx,
            total=len(media_items),
        )
        
        if status == "downloaded":
            success += 1
        else:
            failed += 1

    print(
        f"\n[done] Summary: total={len(media_items)} successfully_sent={success} failed={failed}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Send media tasks from a CoomerFans performer page to a local downloader API."
    )
    parser.add_argument(
        "--profile-url",
        help="Full creator profile URL (e.g. https://coomerfans.com/u/fansly/397975/ALYSSIA_KENT).",
    )
    parser.add_argument(
        "--platform",
        choices=["onlyfans", "fansly"],
        help="Creator platform in profile URL (onlyfans or fansly).",
    )
    parser.add_argument("--performer-id", help="Performer numeric ID.")
    parser.add_argument(
        "--performer-slug",
        help="Performer slug/username path segment.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=999,
        help="Max listing pages to crawl (50 posts per page offset).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Discover and list media without sending requests.",
    )
    parser.add_argument(
        "--content-mode",
        choices=["all-content", "videos", "images"],
        default="all-content",
        help="Choose what to process: all-content, videos, or images.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Only process the first N discovered media files.",
    )
    args = parser.parse_args()

    profile_url = args.profile_url
    if not profile_url:
        profile_url = input(
            "Paste creator profile URL (or press Enter to input fields manually): "
        ).strip()

    if profile_url:
        try:
            platform, performer_id, performer_slug = parse_profile_url(profile_url)
        except ValueError as exc:
            raise SystemExit(f"Invalid --profile-url: {exc}") from exc
    else:
        performer_id = args.performer_id or input(
            "Enter performer ID (e.g. the 123456 in https://coomerfans.com/u/onlyfans/123456/performer_slug): "
        ).strip()
        if not performer_id:
            raise SystemExit("performer-id is required")
        platform = args.platform or input("Enter platform (onlyfans/fansly): ").strip().lower()
        if platform not in {"onlyfans", "fansly"}:
            raise SystemExit("platform must be onlyfans or fansly")
        performer_slug = args.performer_slug or input("Enter performer slug: ").strip()
        if not performer_slug:
            raise SystemExit("performer-slug is required")

    run(
        platform=platform,
        performer_id=performer_id,
        performer_slug=performer_slug,
        max_pages=max(1, args.max_pages),
        dry_run=args.dry_run,
        content_mode=args.content_mode,
        limit=args.limit if args.limit and args.limit > 0 else None,
    )


if __name__ == "__main__":
    main()