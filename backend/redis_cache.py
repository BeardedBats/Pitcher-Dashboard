"""Redis cache abstraction layer using Upstash Redis.

Provides L2 cache (Redis) behind the existing L1 (in-memory dict) caches.
Falls back gracefully when Redis is unavailable (e.g., local development).
"""
import os
import json

_redis = None
_redis_checked = False


def _get_redis():
    """Lazy-initialize the Upstash Redis client."""
    global _redis, _redis_checked
    if _redis_checked:
        return _redis
    _redis_checked = True
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if url and token:
        try:
            from upstash_redis import Redis
            _redis = Redis(url=url, token=token)
        except Exception as e:
            print(f"[Redis] Failed to connect: {e}")
            _redis = None
    return _redis


def redis_get(key):
    """Get a value from Redis. Returns deserialized Python object or None."""
    r = _get_redis()
    if r is None:
        return None
    try:
        val = r.get(key)
        if val is None:
            return None
        # upstash-redis Python SDK returns the value already decoded
        if isinstance(val, str):
            return json.loads(val)
        return val
    except Exception as e:
        print(f"[Redis] GET error for {key}: {e}")
        return None


def redis_set(key, value, ttl=None):
    """Set a value in Redis. Serializes to JSON."""
    r = _get_redis()
    if r is None:
        return
    try:
        data = json.dumps(value)
        if ttl:
            r.setex(key, ttl, data)
        else:
            r.set(key, data)
    except Exception as e:
        print(f"[Redis] SET error for {key}: {e}")


def redis_delete(key):
    """Delete a single key from Redis."""
    r = _get_redis()
    if r is None:
        return
    try:
        r.delete(key)
    except Exception as e:
        print(f"[Redis] DELETE error for {key}: {e}")


def redis_delete_pattern(pattern):
    """Delete all keys matching a glob pattern. Use sparingly."""
    r = _get_redis()
    if r is None:
        return
    try:
        cursor = 0
        while True:
            result = r.scan(cursor, match=pattern, count=100)
            cursor = result[0]
            keys = result[1]
            if keys:
                for k in keys:
                    r.delete(k)
            if cursor == 0:
                break
    except Exception as e:
        print(f"[Redis] DELETE pattern error for {pattern}: {e}")


