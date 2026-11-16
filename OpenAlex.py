import urllib.parse
import requests
import time

class OpenAlex:
    def __init__(self, lang="pt", api_key=None):
        lang = str(lang).strip().lower()
        self._fileName = __file__.split('/')[-1]
        self.lang = lang
        self.api_key = api_key
        self.lastResponse = None
        self.base_url = "https://api.openalex.org/works"

        self.s = requests.Session()
        self.s.headers.update({"User-Agent": "openAlexCrawlerBolado/1.0 (emailcontato@gmail.com)"})
        self.s.headers.update({"Authorization": f"Bearer {self.api_key}"})

    @staticmethod
    def _retry(f, timeout=1.0, repeat=1):
        if repeat == 0:
            raise Exception("Retry attempts exceeded!")
        try:
            return f()
        except:
            time.sleep(timeout)
            return OpenAlex._retry(f, timeout, repeat-1)

    def getWorks(self, **kwargs):
        if not kwargs:
            raise Exception(f"[{self._fileName}] No args passed into getWorks()")

        if "filter" not in kwargs:
            kwargs["filter"] = f"language:{self.lang}"

        url = f"{self.base_url}?{urllib.parse.urlencode(kwargs)}"

        r = OpenAlex._retry(lambda: self.s.get(url), timeout=0.5, repeat=2)
        self.lastResponse = r

        json = None
        try:
            json = r.json()
        except:
            raise Exception(r.status_code, r.text)
        return json

    @staticmethod
    def getWorksRelated(workContent):
        res = workContent.get("referenced_works")
        if not res:
            return None

        res = list(set(res))

        return res
