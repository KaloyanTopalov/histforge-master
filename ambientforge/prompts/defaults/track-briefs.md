<!-- mock-response: {"tracks":[{"trackNumber":1,"title":"Drift One","lyrics":""},{"trackNumber":2,"title":"Drift Two","lyrics":""},{"trackNumber":3,"title":"Drift Three","lyrics":""},{"trackNumber":4,"title":"Drift Four","lyrics":""},{"trackNumber":5,"title":"Drift Five","lyrics":""},{"trackNumber":6,"title":"Drift Six","lyrics":""},{"trackNumber":7,"title":"Drift Seven","lyrics":""},{"trackNumber":8,"title":"Drift Eight","lyrics":""},{"trackNumber":9,"title":"Drift Nine","lyrics":""},{"trackNumber":10,"title":"Drift Ten","lyrics":""},{"trackNumber":11,"title":"Drift Eleven","lyrics":""},{"trackNumber":12,"title":"Drift Twelve","lyrics":""},{"trackNumber":13,"title":"Drift Thirteen","lyrics":""},{"trackNumber":14,"title":"Drift Fourteen","lyrics":""},{"trackNumber":15,"title":"Drift Fifteen","lyrics":""},{"trackNumber":16,"title":"Drift Sixteen","lyrics":""},{"trackNumber":17,"title":"Drift Seventeen","lyrics":""},{"trackNumber":18,"title":"Drift Eighteen","lyrics":""},{"trackNumber":19,"title":"Drift Nineteen","lyrics":""},{"trackNumber":20,"title":"Drift Twenty","lyrics":""},{"trackNumber":21,"title":"Drift Twenty One","lyrics":""},{"trackNumber":22,"title":"Drift Twenty Two","lyrics":""},{"trackNumber":23,"title":"Drift Twenty Three","lyrics":""},{"trackNumber":24,"title":"Drift Twenty Four","lyrics":""},{"trackNumber":25,"title":"Drift Twenty Five","lyrics":""},{"trackNumber":26,"title":"Drift Twenty Six","lyrics":""},{"trackNumber":27,"title":"Drift Twenty Seven","lyrics":""},{"trackNumber":28,"title":"Drift Twenty Eight","lyrics":""},{"trackNumber":29,"title":"Drift Twenty Nine","lyrics":""},{"trackNumber":30,"title":"Drift Thirty","lyrics":""}]} -->

You are writing {{tracksPerAlbum}} track briefs for the album "{{album.albumTitle}}" by "{{channel.displayName}}".

Album style: {{album.sunoStylePrompt}}
Genre: {{album.primaryGenre}}

Return ONLY valid JSON, no prose, no code fences, of this exact shape:
{
  "tracks": [
    { "trackNumber": 1, "title": "...", "lyrics": "..." },
    ... (exactly {{tracksPerAlbum}} entries, trackNumber 1..{{tracksPerAlbum}} in order)
  ]
}

Genre branching for the lyrics field:
- If genre is hip-hop, rap, vocal, R&B, country, pop, or any sung style: write full lyrics (verses + chorus, ~12-24 lines).
- If genre is ambient, instrumental, lofi-instrumental, meditation, sleep, or any wordless style: lyrics is the empty string "".

Title constraints: 1-5 words, evocative, no surrounding quotes.
