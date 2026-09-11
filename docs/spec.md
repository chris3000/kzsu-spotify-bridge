We're going to create a service that can parse the song list from KZSU's Zootopia College Rock channel. The JSON for recent songs can be found at this URL: http://kzsu.rocks/songs

The service will query the JSON once every hour, parse the songs, and will look up the song on any registered music streaming services (for example, Spotify). If found, the song will be saved into a database.

The database should save the following:
* Song title
* Song artist
* Song year released
* Date added to the database
* Any song ids and other relevant info from the registered music services. For example, a Spotify ID would be like this: "spotifyId": "2q6qz5PfBJFjWvhsAL31eP"

Every morning at 3am, the service will use the database to create audio playlists. We will start with Spotify but the code should be abstract enough to easily handle other audio streaming services in the future.
The logic for picking songs is based on how many times it's been picked in the past, and how recently was the last pick. You'll probably need the following info in the db record:
* How many times the track has been selected for a playlist
* Last date the track was selected for a playlist

The name for the playlist should be configurable but will be something like "Indie Rock Dynamic Playlist", which will get updated every morning. There should also be a playlist called "Zootopia- Yesterday's Songs" which will be all of the songs identified from yesterday's zootopia playlist.

Create a dashboard that lets me monitor how many songs are in the database, and other filtering options.

Recommend a database product and hosting service for the data that is the best fit for this project.

Go into planning mode, evaluate this spec, and ask followup questions that stress test this spec.