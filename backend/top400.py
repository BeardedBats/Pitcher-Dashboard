"""Top 400 pitcher names for pre-computation (mirrors frontend/src/top400.js)."""
import unicodedata

TOP_400_NAMES = {
    "Garrett Crochet", "Paul Skenes", "Tarik Skubal", "Bryan Woo", "Yoshinobu Yamamoto",
    "Max Fried", "Cristopher Sánchez", "Logan Gilbert", "Hunter Greene", "Hunter Brown",
    "Shohei Ohtani", "Logan Webb", "Joe Ryan", "Freddy Peralta", "Jacob deGrom",
    "Cole Ragans", "George Kirby", "Tyler Glasnow", "Chris Sale", "Kyle Bradish",
    "Eury Pérez", "Nick Pivetta", "Ryan Pepiot", "Drew Rasmussen", "Cam Schlittler",
    "Sandy Alcantara", "Framber Valdez", "Michael King", "Dylan Cease", "Jesús Luzardo",
    "Kevin Gausman", "Trevor Rogers", "Tatsuya Imai", "Nolan McLean", "Bubba Chandler",
    "Trey Yesavage", "Cade Horton", "Robbie Ray", "Nathan Eovaldi", "Jacob Misiorowski",
    "Chase Burns", "Shane McClanahan", "Kris Bubic", "Blake Snell", "Bryce Miller",
    "Edward Cabrera", "Andrew Abbott", "Shota Imanaga", "Aaron Nola", "MacKenzie Gore",
    "Emmet Sheehan", "Ryan Weathers", "Nick Lodolo", "Sonny Gray", "Ranger Suárez",
    "Noah Cameron", "Gavin Williams", "Shane Baz", "Ryne Nelson", "Joe Musgrove",
    "Zac Gallen", "Brandon Woodruff", "Gerrit Cole", "Zack Wheeler", "Carlos Rodon",
    "Jared Jones", "Spencer Schwellenbach", "Shane Bieber", "Matthew Boyd", "Luis Castillo",
    "Merrill Kelly", "Zach Eflin", "Andrew Painter", "Spencer Strider", "Logan Henderson",
    "Robby Snelling", "Braxton Ashcraft", "Tanner Bibee", "Jack Flaherty", "Kodai Senga",
    "Joey Cantillo", "Bailey Ober", "Cody Ponce", "Brayan Bello", "Seth Lugo",
    "Landen Roupp", "Tyler Mahle", "Max Scherzer", "Quinn Priester", "Ryan Weiss",
    "Shane Smith", "Jack Leiter", "Cristian Javier", "Zebby Matthews", "Mike Burrows",
    "Grant Holmes", "Grayson Rodriguez", "Spencer Arrighetti", "Jacob Lopez", "Will Warren",
    "Reid Detmers", "Reynaldo López", "Roki Sasaki", "Jacob Latz", "Justin Wrobleski",
    "Kyle Harrison", "Mick Abel", "Parker Messick", "Ben Casparius", "Lucas Giolito",
    "Troy Melton", "Connelly Early", "Payton Tolle", "Carson Whisenhunt", "Brandon Sproat",
    "Luis Gil", "Simeon Woods Richardson", "Sean Manaea", "Cade Cavalli", "Johan Oviedo",
    "José Soriano", "Joey Wentz", "Connor Prielipp", "Thomas White", "Gage Jump",
    "Jaxon Wiggins", "Hagen Smith", "Noah Schultz", "Brody Hopkins", "Luis Perales",
    "Daniel Espino", "Alex Clemmey", "Carlos Lagrange", "Yusei Kikuchi", "Casey Mize",
    "Dustin May", "Justin Verlander", "Clay Holmes", "David Peterson", "Matthew Liberatore",
    "Slade Cecconi", "Brady Singer", "Brandon Pfaadt", "Mitch Keller", "Jameson Taillon",
    "Eduardo Rodriguez", "Michael Wacha", "Nick Martinez", "Luis Severino", "Corbin Burnes",
    "Justin Steele", "Clarke Schmidt", "Jackson Jobe", "Hurston Waldrep", "Kyle Leahy",
    "Triston McKenzie", "Ian Seymour", "Rhett Lowder", "Joe Rock", "Tyler Wells",
    "Jonah Tong", "Cade Povich", "Alan Rangel", "Alek Manoah", "Braxton Garrett",
    "Max Meyer", "Richard Fitts", "Hunter Dobbins", "AJ Blubaugh", "Quinn Mathews",
    "Elmer Rodri\u00adguez-Cruz", "Elmer Rodriguez-Cruz", "Tanner McDougal", "Khal Stephen",
    "Jake Bennett", "Didier Fuentes",
    "Bryce Mayer", "Ty Johnson", "Jurrangelo Cijntje", "David Davalillo", "Miguel Mendez",
    "Jack Wenninger", "Marco Raya", "Tink Hence", "Santiago Suarez", "Anderson Brito",
    "Miguel Ullola", "George Klassen", "Nick Frasso", "Davis Martin", "Chris Bassitt",
    "Jeffrey Springs", "Adrian Houser", "Chris Paddack", "Foster Griffin", "Michael McGreevy",
    "José Berrios", "JP Sears", "Jason Alexander", "Chad Patrick", "Janson Junk",
    "Dean Kremer", "Michael Soroka", "Logan Allen", "Luis Morales", "River Ryan",
    "Gavin Stone", "Taj Bradley", "José Urquidy", "Anthony Kay", "Steven Matz",
    "Blade Tidwell", "Zack Littell", "Brandon Williamson", "Ryan Bergert", "Kutter Crawford",
    "Kumar Rocker", "Yoendrys Gómez", "David Festa", "Trevor McDonald", "Hayden Birdsong",
    "Ben Brown", "Tobias Myers", "Robert Gasser", "Drey Jameson", "Carmen Mlodzinski",
    "Colton Gordon", "Joe Boyle", "Jedixson Paez", "Jordan Wicks", "Luis Medina",
    "Jack Perkins", "Drew Anderson", "J.T. Ginn", "Stephen Kolek", "Jake Miller",
    "Winston Santos", "Christian Oppor", "Mason Morris", "Kelvis Salcedo", "Jackson Ferris",
    "Chase Hampton", "Gage Wood", "Ryan Sloan", "Caden Scarborough", "Ricky Tiedemann",
    "Gage Stanifer", "Jarlin Susana", "Andre Pallante", "Brad Lord", "Aaron Civale",
    "Lance McCullers Jr.", "Taijuan Walker", "Sean Burke", "Bryce Elder", "Josiah Gray",
    "Miles Mikolas", "Erick Fedde", "Germán Márquez", "Randy Vasquez", "Chase Dollander",
    "Kyle Freeland", "Jose Quintana", "Michael Lorenzen", "Tomoyuki Sugano", "Daniel Eagen",
    "Mitch Bratt", "Drue Hackenberg", "JR Ritchie", "Nestor German", "Trey Gibson",
    "Will Dion", "Braden Nett", "Steven Echavarria", "Felix Arronde", "Chris Cortez",
    "Patrick Copen", "Peter Heubeck", "Dax Fulton", "Karson Milbrandt", "Noble Meyer",
    "Bishop Letson", "Andrew Morris", "Jonathan Pintaro", "Jonathan Santucci", "Will Watson",
    "Henry Lalane", "Yoniel Curet", "Hunter Barco", "Wilber Dotel", "Hunter Dryden",
    "Chen-Wei Lin", "Jackson Baumeister", "T.J. Nichols", "Gary Gill Hill", "Eriq Swan",
    "Martín Pérez", "Carson Seymour", "Bobby Miller", "Emerson Hancock", "Adam Mazur",
    "Jack Kochanowicz", "Caden Dana", "Colin Rea", "Javier Assad", "Jonathan Cannon",
    "Walker Buehler", "Bradley Blalock", "Eric Lauer", "Caleb Kilian", "Patrick Sandoval",
    "Shinnosuke Ogasawara", "Mitchell Parker", "Jake Irvin", "Keider Montero", "Roddery Muñoz",
    "Bailey Falter", "Daniel Lynch IV", "Cal Quantrill", "Dietrich Enns", "Kyle Hart",
    "Kyson Witherspoon", "Braylon Doughty", "Argenis Cayama", "Zachary Root", "Adam Serwinowski",
    "Christian Zazueta", "J.D. Thompson", "Dasan Hill", "Charlee Soto", "Bryce Cunningham",
    "Moises Chace", "Antwone Kelly", "Seth Hernandez", "Bryan Balzer", "Kash Mayfield",
    "Kruz Schoolcraft", "Kade Anderson", "Tekoah Roby", "Liam Doyle", "Alejandro Rosario",
    "Travis Sykora", "Cam Caminiti", "Jamie Arnold", "McCade Brown", "Tanner Gordon",
    "Antonio Senzatela", "Ryan Feltner", "Gunnar Hoglund", "Cody Bradford", "Jordan Montgomery",
    "Christian Scott", "DJ Herz", "Jake Bloss", "AJ Smith-Shawver", "Nestor Cortes",
    "Tylor Megill", "Hayden Wesneski", "Ronel Blanco", "Griffin Canning", "Trevor Williams",
    "Jon Gray", "Wade Miley", "Tyler Anderson", "Patrick Corbin", "Charlie Morton",
    "Alex Cobb", "Michael Kopech", "Marcus Stroman", "Spencer Turnbull", "Pablo López",
    "Logan Evans", "Reese Olson", "Bowden Francis", "Yu Darvish", "John Means",
    "Tanner Houck", "Frankie Montas", "Alec Marsh", "Nabil Crismatt", "Blake Walston",
    "Tommy Henry", "Yu-Min Lin", "Yilber Díaz", "Bryce Jarvis", "Cristian Mena",
    "Joe Ross", "Joey Estes", "Mason Barnett", "Mitch Spence", "Carlos Carrasco",
    "Brandon Young", "Kyle Wright", "Vince Velasquez", "Ky Bush", "Grant Taylor",
    "Drew Thorpe", "Wikelman Gonzalez", "Carson Spiers", "Graham Ashcraft", "Julian Aguiar",
    "Doug Nikhazy", "Emanuel De Jesus", "Ty Madden", "J.P. France", "Sam Aldegheri",
    "Chase Silseth", "Victor Mederos", "Cole Irvin", "Ryan Gusto", "Aaron Ashby",
    "DL Hall", "Drew Rom", "Gerson Garabito", "Justin Hagenman", "Ryan Yarbrough",
    "Paul Blackburn", "Mason Montgomery", "Mike Clevinger", "Thomas Harrington", "Marco Gonzales",
    "Matt Waldron", "Cooper Criswell", "Dane Dunning", "Randy Dobnak", "JT Brubaker",
    "Kai-Wei Teng", "Jake Woodford", "Jesse Scholtens", "Austin Gomber", "Jake Eder",
    "José Ureña",
    "Sean Newcomb", "Julio Teheran", "Elmer Rodriguez", "Aaron Sanchez",
    "Huascar Ynoa", "Brent Suter", "TJ Nichols", "Ryan Johnson",
}


def _strip_accents(s):
    """Remove diacritics and soft hyphens for name matching."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)
    ).replace("\u00ad", "")


# Pre-build normalized lookup: stripped lowercase → original name
_normalized = {_strip_accents(n).lower(): n for n in TOP_400_NAMES}


def is_top400(name):
    """Check if a pitcher name is in the Top 400 list (accent-insensitive)."""
    if not name:
        return False
    if name in TOP_400_NAMES:
        return True
    return _strip_accents(name).lower() in _normalized
