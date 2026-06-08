import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { db, client } from "../src/db";
import {
  players as playersTable,
  nations as nationsTable,
  playerRankings as playerRankingsTable,
} from "../src/db/schema";
import { sql } from "drizzle-orm";
import {
  normalizeName,
  matchPlayerByName,
  chunkArray,
  type FantasyPosition,
  type DbPlayer,
} from "./lib/name-matcher";

// ── play_status derivation ─────────────────────────────────────────────────────
// rank 1→definite_starter, 2→probable_starter, 3→possible_starter,
// 4→probable_substitute, 5→possible_substitute, 6+→wont_play_much
// GTD: downgrade one level, floored at possible_starter (index 2).
// OUT: force wont_play_much.

type PlayStatus =
  | "definite_starter"
  | "probable_starter"
  | "possible_starter"
  | "probable_substitute"
  | "possible_substitute"
  | "wont_play_much";

const STATUS_LEVELS: PlayStatus[] = [
  "definite_starter",
  "probable_starter",
  "possible_starter",
  "probable_substitute",
  "possible_substitute",
  "wont_play_much",
];

const POSSIBLE_STARTER_IDX = 2; // floor index for GTD

function rankToStatus(rank: number, tag: "GTD" | "OUT" | null): PlayStatus {
  if (tag === "OUT") return "wont_play_much";
  const baseIdx = rank <= 1 ? 0 : rank === 2 ? 1 : rank === 3 ? 2 : rank === 4 ? 3 : rank === 5 ? 4 : 5;
  if (tag === "GTD") {
    const downgraded = Math.min(baseIdx + 1, STATUS_LEVELS.length - 1);
    return STATUS_LEVELS[Math.min(downgraded, POSSIBLE_STARTER_IDX)];
  }
  return STATUS_LEVELS[baseIdx];
}

// ── Name overrides (same RotoWire source as projections CSV) ─────────────────
// Key: "DBNationName:PDFName"
const NAME_OVERRIDES: Record<string, string> = {
  "Morocco:Bono":               "Yassine Bounou",
  "Morocco:Ez Abde":            "Abde Ezzalzouli",
  "Scotland:Andrew Robertson":  "Andy Robertson",
  "Australia:Cameron Devlin":   "Cammy Devlin",
  "Spain:Alejandro Grimaldo":   "Álex Grimaldo",
  "Saudi Arabia:Nawaf Bu Washl":"Nawaf Boushal",
  "Uzbekistan:Farruh Sayfiyev": "Farrukh Sayfiev",
  "Mexico:Jose Rangel":         "Raúl Rangel",
  "Jordan:Mohammad Abualnadi":  "Mo Abualnadi",
};

// ── Depth chart data ───────────────────────────────────────────────────────────
// Player strings: "Name" | "Name/GTD" | "Name/OUT"
// Arrays are depth-ordered; index+1 = rank.

type NationDef = {
  pdfName: string;
  dbName: string;
  GK: string[];
  DEF: string[];
  MID: string[];
  FWD: string[];
};

const NATIONS: NationDef[] = [
  {
    pdfName: "Argentina", dbName: "Argentina",
    GK:  ["Emiliano Martinez/GTD", "Geronimo Rulli", "Juan Musso"],
    DEF: ["Nicolas Otamendi", "Nahuel Molina/GTD", "Nicolas Tagliafico", "Lisandro Martinez", "Cristian Romero", "Valentin Barco", "Gonzalo Montiel/GTD", "Facundo Medina"],
    MID: ["Enzo Fernandez", "Rodrigo De Paul", "Alexis Mac Allister", "Exequiel Palacios", "Nico Paz/GTD", "Giovani Lo Celso", "Leandro Paredes/GTD", "Thiago Almada"],
    FWD: ["Lionel Messi/GTD", "Julian Alvarez/GTD", "Nicolas Gonzalez/GTD", "Lautaro Martinez", "Giuliano Simeone", "Jose Lopez"],
  },
  {
    pdfName: "Australia", dbName: "Australia",
    GK:  ["Mathew Ryan", "Paul Izzo", "Patrick Beach"],
    DEF: ["Alessandro Circati", "Harry Souttar", "Cameron Burgess", "Jordan Bos", "Jacob Italiano", "Lucas Herrington", "Aziz Behich", "Milos Degenek", "Jason Geria", "Kai Trewin"],
    MID: ["Jackson Irvine", "Conor Metcalfe", "Ajdin Hrustic", "Aiden O'Neill", "Paul Okon", "Cameron Devlin"],
    FWD: ["Mohamed Toure", "Cristian Volpato", "Nestory Irankunda", "Awer Mabil", "Mathew Leckie", "Nishan Velupillay", "Tete Yengi"],
  },
  {
    pdfName: "Belgium", dbName: "Belgium",
    GK:  ["Thibaut Courtois", "Senne Lammens", "Mike Penders"],
    DEF: ["Maxim De Cuyper", "Thomas Meunier", "Arthur Theate", "Koni De Winter", "Brandon Mechele", "Timothy Castagne", "Zeno Koen Debast/OUT", "Nathan Ngoy", "Joaquin Seys"],
    MID: ["Kevin De Bruyne", "Amadou Onana", "Jeremy Doku", "Youri Tielemans", "Leandro Trossard", "Dodi Lukebakio", "Axel Witsel", "Alexis Saelemaekers", "Hans Vanaken", "Nicolas Raskin", "Diego Moreira"],
    FWD: ["Charles De Ketelaere", "Romelu Lukaku", "Matias Fernandez-Pardo"],
  },
  {
    pdfName: "Brazil", dbName: "Brazil",
    GK:  ["Alisson", "Ederson", "Weverton"],
    DEF: ["Gabriel", "Marquinhos", "Alex Sandro", "Danilo", "Leo Pereira", "Gleison Bremer", "Roger Ibanez", "Douglas"],
    MID: ["Casemiro", "Bruno Guimaraes", "Fabinho", "Lucas Paqueta", "Ederson", "Danilo"],
    FWD: ["Vinicius Junior", "Raphinha", "Matheus Cunha", "Gabriel Martinelli", "Luiz Henrique", "Igor Thiago", "Neymar/GTD", "Endrick", "Rayan"],
  },
  {
    pdfName: "Colombia", dbName: "Colombia",
    GK:  ["Camilo Vargas", "David Ospina", "Alvaro David Montero Perales"],
    DEF: ["Daniel Munoz", "Davinson Sanchez", "Jhon Lucumi", "Johan Mojica", "Yerry Mina", "Santiago Arias", "Deiver Andres Machado", "Willer Ditta"],
    MID: ["James Rodriguez", "Jefferson Lerma", "Richard Rios Montoya", "Juan Quintero", "Jorge Carrascal", "Jaminton Campaz", "Kevin Castano", "Gustavo Puerta", "Juan Portilla"],
    FWD: ["Luis Diaz", "Luis Suarez", "Jhon Arias", "Cucho Hernandez", "Andres Gomez", "Jhon Cordoba"],
  },
  {
    pdfName: "Croatia", dbName: "Croatia",
    GK:  ["Dominik Livakovic", "Dominik Kotarski", "Ivor Pandur"],
    DEF: ["Josko Gvardiol", "Josip Stanisic", "Luka Vuskovic", "Duje Caleta-Car", "Josip Sutalo", "Martin Erlic", "Marin Pongracic", "Kristijan Jakic"],
    MID: ["Luka Modric", "Mateo Kovacic", "Mario Pasalic", "Martin Baturina", "Nikola Vlasic", "Nikola Moro", "Luka Sucic", "Petar Sucic", "Toni Fruk"],
    FWD: ["Andrej Kramaric", "Ivan Perisic", "Ante Budimir", "Petar Musa", "Igor Matanovic", "Marco Pasalic"],
  },
  {
    pdfName: "Egypt", dbName: "Egypt",
    GK:  ["Mostafa Ahmed Abdelaziz Mohamed Shobeir", "Mohamed El Shenawy", "El Mahdy Mohamed Soliman Ibrahim", "Mohamed Alaa"],
    DEF: ["Mohamed Abdelmonem", "Yasser Ahmed Ibrahim El Hanafi", "Ahmed El Fotouh", "Mohamed Hany Gamal Eldemerdash", "Ramy Rabia", "Hossam Abdelmaguid", "Tarek Alaa El Gebaly", "Karim Hafez"],
    MID: ["Marwan Attia Fahim Ghallab", "Trezeguet", "Emam Ashour", "Hamdi Fathy Abdelhalim Abdel Fattah", "Zizo", "Mahmoud Saber", "Ibrahim Adel", "Haissem Hassan", "Mohanad Lasheen", "Nabil Emad Dunga"],
    FWD: ["Mohamed Salah", "Omar Marmoush", "Hamza Abdelkarim", "Mostafa Zico"],
  },
  {
    pdfName: "England", dbName: "England",
    GK:  ["Jordan Pickford", "James Trafford", "Dean Henderson"],
    DEF: ["Marc Guehi", "Ezri Konsa", "Reece James", "Nico O'Reilly", "John Stones", "Valentino Livramento", "Djed Spence", "Dan Burn", "Jarell Quansah"],
    MID: ["Declan Rice", "Jude Bellingham", "Elliot Anderson", "Morgan Rogers", "Kobbie Mainoo", "Jordan Henderson", "Eberechi Eze"],
    FWD: ["Harry Kane", "Bukayo Saka", "Marcus Rashford", "Anthony Gordon", "Noni Madueke", "Ollie Watkins", "Ivan Toney"],
  },
  {
    pdfName: "France", dbName: "France",
    GK:  ["Mike Maignan", "Brice Samba", "Robin Risser"],
    DEF: ["Jules Kounde", "Dayot Upamecano", "Theo Hernandez", "William Saliba/GTD", "Ibrahima Konate", "Malo Gusto", "Maxence Lacroix", "Lucas Digne", "Lucas Hernandez"],
    MID: ["Ousmane Dembele", "Michael Olise", "Aurelien Tchouameni", "Adrien Rabiot", "Desire Doue", "N'Golo Kante", "Rayan Cherki", "Warren Zaire-Emery", "Maghnes Akliouche", "Manu Kone"],
    FWD: ["Kylian Mbappe", "Marcus Thuram", "Bradley Barcola", "Jean-Philippe Mateta"],
  },
  {
    pdfName: "Germany", dbName: "Germany",
    GK:  ["Manuel Neuer/GTD", "Oliver Baumann", "Alexander Nubel"],
    DEF: ["Joshua Kimmich", "Nico Schlotterbeck", "Jonathan Tah", "David Raum", "Nathaniel Brown", "Antonio Rudiger", "Waldemar Anton", "Malick Thiaw"],
    MID: ["Florian Wirtz", "Jamal Musiala", "Aleksandar Pavlovic", "Leon Goretzka", "Leroy Sane", "Angelo Stiller", "Pascal Gross", "Felix Nmecha", "Nadiem Amiri", "Assan Ouedraogo"],
    FWD: ["Kai Havertz", "Nick Woltemade", "Deniz Undav", "Maximilian Beier", "Jamie Leweling"],
  },
  {
    pdfName: "Iran", dbName: "Iran",
    GK:  ["Alireza Beiranvand", "Hossein Hosseini", "Payam Niazmand"],
    DEF: ["Shoja Khalilzadeh", "Ali Nemati", "Milad Mohammadi", "Aria Yousefi", "Ehsan Hajsafi", "Hossein Kanaanizadegan", "Danial Iri", "Ramin Rezaeian", "Saleh Hardani"],
    MID: ["Saman Ghoddos", "Mohammad Mohebi/GTD", "Mehdi Ghayedi", "Saeid Ezatolahi", "Alireza Jahanbakhsh", "Amir Mohammad Razzaghinia", "Mehdi Torabi/GTD", "Mohammad Ghorbani", "Roozbeh Cheshmi/GTD"],
    FWD: ["Mehdi Taremi", "Amirhossein Hosseinzadeh", "Ali Alipour", "Dennis Eckert/GTD", "Shahriyar Moghanlou"],
  },
  {
    pdfName: "Japan", dbName: "Japan",
    GK:  ["Zion Suzuki", "Keisuke Osako", "Tomoki Hayakawa"],
    DEF: ["Hiroki Ito", "Ko Itakura", "Takehiro Tomiyasu", "Shogo Taniguchi", "Tsuyoshi Watanabe", "Ayumu Seko", "Junnosuke Suzuki", "Yukinari Sugawara", "Yuto Nagatomo"],
    MID: ["Takefusa Kubo", "Ritsu Doan", "Junya Ito", "Daichi Kamada", "Keito Nakamura", "Wataru Endo/GTD", "Ao Tanaka", "Kaishu Sano", "Yuito Suzuki"],
    FWD: ["Ayase Ueda", "Daizen Maeda", "Keisuke Goto", "Kento Shiogai", "Koki Ogawa"],
  },
  {
    pdfName: "Mexico", dbName: "Mexico",
    GK:  ["Jose Rangel", "Guillermo Ochoa", "Carlos Acevedo"],
    DEF: ["Johan Vasquez", "Cesar Montes", "Jesus Gallardo", "Jorge Eduardo Sanchez", "Israel Reyes", "Mateo Chavez"],
    MID: ["Erik Lira", "Alvaro Fidalgo", "Gilberto Mora", "Edson Alvarez", "Brian Gutierrez", "Luis Chavez", "Orbelin Pineda", "Luis Romo", "Obed Vargas"],
    FWD: ["Raul Jimenez", "Roberto Alvarado", "Julian Quinones", "Alexis Vega", "Santiago Gimenez/GTD", "Cesar Huerta", "Armando Gonzalez", "Guillermo Martinez"],
  },
  {
    pdfName: "Morocco", dbName: "Morocco",
    GK:  ["Bono", "Munir", "Ahmed Reda Tagnaouti"],
    DEF: ["Achraf Hakimi", "Issa Diop", "Noussair Mazraoui/GTD", "Nayef Aguerd/GTD", "Chadi Riad", "Redouane Halhal", "Anass Salah-Eddine", "Youssef Belammari", "Zakaria El Ouahdi"],
    MID: ["Ismael Saibari", "Bilal El Khannouss", "Neil El Aynaoui", "Azzedine Ounahi", "Sofyan Amrabat", "Samir El Mourabet", "Chemsdine Talbi/GTD", "Gessime Yassine", "Ayyoub Bouaddi"],
    FWD: ["Ez Abde/OUT", "Brahim Diaz", "Ayoub El Kaabi", "Soufiane Rahimi", "Ayoube Amaimouni-Echghouyab"],
  },
  {
    pdfName: "Panama", dbName: "Panama",
    GK:  ["Orlando Mosquera", "Cesar Samudio", "Luis Mejia Cajar/GTD"],
    DEF: ["Amir Murillo", "Eric Davis", "Jose Cordoba", "Andres Andrade Cedeno", "Roderick Miller", "Cesar Blackman", "Jiovany Ramos", "Jorge Gutierrez", "Fidel Escobar", "Edgardo Farina"],
    MID: ["Adalberto Carrasquilla/GTD", "Anibal Godoy/GTD", "Jose Luis Rodriguez", "Carlos Harvey", "Cristian Martinez", "Yoel Barcenas", "Alberto Quintero", "Azarias Londono"],
    FWD: ["Ismael Diaz", "Cecilio Waterman", "Jose Fajardo", "Cesar Yanis", "Tomas Rodriguez"],
  },
  {
    pdfName: "Portugal", dbName: "Portugal",
    GK:  ["Diogo Costa", "Jose Sa", "Rui Silva"],
    DEF: ["Nuno Mendes", "Joao Cancelo", "Ruben Dias", "Goncalo Inacio", "Diogo Dalot", "Renato Veiga", "Nelson Semedo", "Tomas Araujo", "Matheus Nunes"],
    MID: ["Bruno Fernandes", "Vitinha", "Joao Neves", "Bernardo Silva", "Ruben Neves", "Samu Costa"],
    FWD: ["Cristiano Ronaldo", "Rafael Leao", "Joao Felix", "Pedro Neto", "Goncalo Ramos", "Francisco Conceicao", "Francisco Trincao", "Goncalo Guedes"],
  },
  {
    pdfName: "Saudi Arabia", dbName: "Saudi Arabia",
    GK:  ["Nawaf Al Aqidi/GTD", "Mohammed Al-Owais", "Ahmed bin Ali bin Hussein Al Kassar"],
    DEF: ["Saud Abdulhamid", "Nawaf Bu Washl", "Hassan Tambakti/GTD", "Ali Lajami", "Ali bin Hassan bin Mohammed Majrashi", "Abdulelah Al-Amri", "Hassan bin Kadish bin Yahya Mahbub", "Moteb Al Harbi"],
    MID: ["Mohamed Kanno", "Musab Al-Juwayr", "Abdullah Al-Khaibari", "Ziyad bin Mubarak bin Eid Al Marwani Al Johani", "Ayman Yahya", "Alaa Al Hejji", "Jehad Thikri", "Mohammed Abu Al Shamat"],
    FWD: ["Salem Al-Dawsari", "Firas Al Buraikan", "Nasser Al Dawsari", "Abdullah Al-Hamdan", "Khalid bin Essa bin Mohammed Al Ghannam", "Saleh Al Shehri", "Sultan bin Ahmed bin Mohammed Mandash"],
  },
  {
    pdfName: "Senegal", dbName: "Senegal",
    GK:  ["Edouard Mendy", "Mory Diaw", "Yehvann Diouf"],
    DEF: ["Kalidou Koulibaly/GTD", "Krepin Diatta", "Moussa Niakhate", "El Hadji Malick Diouf", "Mamadou Sarr", "Ismail Jakobs", "Abdoulaye Seck", "Antoine Mendy"],
    MID: ["Idrissa Gueye/GTD", "Pape Gueye", "Habib Diarra", "Lamine Camara", "Pathe Ciss", "Pape Sarr", "Bara Sapoko Ndiaye"],
    FWD: ["Sadio Mane", "Nicolas Jackson", "Iliman Ndiaye", "Ismaila Sarr", "Ibrahim Mbaye", "Assane Diao", "Cherif Ndiaye", "Ahmadou Bamba Dieng"],
  },
  {
    pdfName: "South Korea", dbName: "South Korea",
    GK:  ["Kim Seung-gyu", "Jo Hyeon-woo", "Song Bum-Keun"],
    DEF: ["Kim Min-Jae", "Seol Young-Woo", "Kim Tae-Hyeon", "Lee Han-Beom", "Lee Tae-Seok/GTD", "Kim Moon-Hwan", "Jens Castrop", "Park Jin-Seob", "Lee Gi-Hyuk", "Cho Wi-Je"],
    MID: ["Lee Kang-in", "Hwang In-beom", "Kim Jin-Gyu", "Lee Jae-Sung", "Paik Seung-Ho", "Eom Ji-Sung", "Lee Dong-Gyeong", "Yang Hyun-Jun", "Bae Jun-Ho/GTD"],
    FWD: ["Son Heung-Min", "Hwang Hee-Chan", "Oh Hyun-Gyu", "Cho Gue-Sung"],
  },
  {
    pdfName: "Spain", dbName: "Spain",
    GK:  ["Unai Simon", "David Raya", "Joan Garcia"],
    DEF: ["Marc Cucurella", "Aymeric Laporte", "Pau Cubarsi", "Pedro Porro", "Eric Garcia", "Marcos Llorente", "Alejandro Grimaldo", "Marc Pubill"],
    MID: ["Pedri", "Rodri", "Fabian Ruiz", "Martin Zubimendi", "Alex Baena", "Gavi", "Mikel Merino"],
    FWD: ["Lamine Yamal/GTD", "Mikel Oyarzabal", "Dani Olmo", "Nico Williams/GTD", "Ferran Torres", "Yeremy Pino", "Victor Munoz/GTD", "Borja Iglesias"],
  },
  {
    pdfName: "Sweden", dbName: "Sweden",
    GK:  ["Kristoffer Nordfeldt", "Viktor Johansson", "Jacob Widell Zetterstrom"],
    DEF: ["Victor Lindelof/GTD", "Daniel Svensson", "Isak Hien", "Gabriel Gudmundsson", "Carl Starfelt", "Gustaf Lagerbielke", "Elliot Stroud", "Hjalmar Ekdal", "Eric Smith"],
    MID: ["Yasin Ayari", "Jesper Karlstrom", "Lucas Bergvall", "Mattias Svanberg", "Besfort Zeneli", "Ken Sema", "Herman Johansson"],
    FWD: ["Viktor Gyokeres", "Alexander Isak", "Anthony Elanga/GTD", "Gustaf Nilsson", "Benjamin Nygren/GTD", "Taha Ali", "Alexander Bernhardsson"],
  },
  {
    pdfName: "Switzerland", dbName: "Switzerland",
    GK:  ["Gregor Kobel", "Yvon Mvogo", "Marvin Keller"],
    DEF: ["Manuel Akanji", "Ricardo Rodriguez", "Silvan Widmer", "Nico Elvedi", "Eray Comert", "Miro Muheim", "Luca Jaquez", "Aurele Amenda"],
    MID: ["Remo Freuler", "Granit Xhaka", "Fabian Rieder", "Denis Zakaria", "Michel Aebischer", "Ardon Jashari", "Johan Manzambi", "Djibril Sow", "Zeki Amdouni", "Christian Fassnacht"],
    FWD: ["Ruben Vargas", "Breel Embolo", "Dan Ndoye", "Noah Okafor", "Cedric Itten"],
  },
  {
    pdfName: "Tunisia", dbName: "Tunisia",
    GK:  ["Aymen Dahmen", "Sabri Ben Hessen", "Abdelmouhib Chamakh"],
    DEF: ["Dylan Bronn", "Montassar Talbi", "Ali El Abdi", "Yan Valery", "Mohamed Amine Ben Hamida", "Omar Rekik", "Moutaz Neffati", "Raed Chikhaoui", "Adem Arous"],
    MID: ["Anis Ben Slimane", "Ellyes Skhiri", "Hannibal/GTD", "Rani Khedira", "Hadj Mahmoud", "Ahmed Mortadha Ben Ouannes", "Ismael Gharbi"],
    FWD: ["Elias Achouri", "Elias Saad", "Hazem Mastouri", "Firas Chaouat", "Sebastian Tounekti", "Khalil Ayari", "Rayan Elloumi"],
  },
  {
    pdfName: "Uruguay", dbName: "Uruguay",
    GK:  ["Fernando Muslera", "Sergio Rochet", "Santiago Mele"],
    DEF: ["Ronald Araujo/GTD", "Mathias Olivera", "Jose Maria Gimenez/GTD", "Guillermo Varela", "Sebastian Caceres/GTD", "Matias Vina", "Santi Bueno", "Joaquin Piquerez Moreira/OUT"],
    MID: ["Federico Valverde", "Manuel Ugarte", "Maxi Araujo", "Rodrigo Bentancur", "Giorgian De Arrascaeta/OUT", "Facundo Pellistri", "Agustin Canobbio Graviz", "Emiliano Martinez", "Nicolas De La Cruz", "Juan Sanabria", "Rodrigo Zalazar", "Brian Rodriguez"],
    FWD: ["Darwin Nunez", "Federico Vinas", "Rodrigo Aguirre"],
  },
  {
    pdfName: "Algeria", dbName: "Algeria",
    GK:  ["Luca Zidane", "Oussama Benbot", "Melvin Mastil"],
    DEF: ["Rayan Ait-Nouri", "Ramy Bensebaini/GTD", "Aissa Mandi", "Rafik Belghali", "Zineddine Belaid", "Samir Chergui", "Jaouen Hadjam", "Mohamed Tougai", "Achref Abada"],
    MID: ["Houssem Aouar", "Fares Chaibi", "Hicham Boudaoui/GTD", "Nabil Bentaleb", "Ibrahim Maza", "Ramiz Zerrouki", "Yacine Titraoui"],
    FWD: ["Riyad Mahrez", "Mohammed Amoura", "Amine Gouiri", "Anis Hadj Moussa", "Adil Boulbina", "Fares Ghedjemis", "Nadhir Benbouali"],
  },
  {
    pdfName: "Austria", dbName: "Austria",
    GK:  ["Alexander Schlager", "Patrick Pentz", "Florian Wiegele"],
    DEF: ["Phillipp Mwene", "Konrad Laimer", "Philipp Lienhart", "David Alaba/GTD", "Stefan Posch", "Kevin Danso", "Marco Friedl", "Michael Svoboda", "David Affengruber"],
    MID: ["Marcel Sabitzer", "Nicolas Seiwald", "Xaver Schlager", "Romano Schmid", "Florian Grillitsch/GTD", "Paul Wanner", "Patrick Wimmer/GTD", "Alexander Prass", "Carney Chukwuemeka", "Alessandro Schopf"],
    FWD: ["Marko Arnautovic", "Michael Gregoritsch", "Sasa Kalajdzic"],
  },
  {
    pdfName: "Bosnia and Herzegovina", dbName: "Bosnia & Herzegovina",
    GK:  ["Nikola Vasilj", "Martin Zlomislic", "Mladen Jurkas"],
    DEF: ["Nikola Katic", "Tarik Muharemovic", "Amar Dedic", "Sead Kolasinac", "Nidal Celik", "Nihad Mujakic", "Stjepan Radeljic", "Dennis Hadzikadunic"],
    MID: ["Esmir Bajraktarevic", "Amar Memic", "Ivan Sunjic/GTD", "Benjamin Tahirovic", "Ivan Basic", "Kerim-Sam Alajbegovic", "Dzenis Burnic", "Amir Hadziahmetovic", "Armin Gigovic", "Ermin Mahmic"],
    FWD: ["Edin Dzeko/GTD", "Ermedin Demirovic", "Haris Tabakovic/OUT", "Jovo Lukic", "Samed Bazdar"],
  },
  {
    pdfName: "Cape Verde", dbName: "Cape Verde Islands",
    GK:  ["Vozinha", "Marcio Rosa", "CJ Dos Santos"],
    DEF: ["Pico", "Logan Costa", "Steven Moreira", "Joao Paulo", "Sidny Lopes Cabral", "Diney", "Wagner Pina", "Kelvin Spencer Pires", "Stopira"],
    MID: ["Jamiro Monteiro", "Kevin Pina", "Yannick Semedo", "Deroy Duarte", "Laros Duarte", "Telmo Arcanjo"],
    FWD: ["Ryan Mendes", "Jovane Cabral", "Dailon Livramento", "Garry Rodrigues", "Nuno", "Willy Semedo", "Helio Varela", "Gilson Benchimol"],
  },
  {
    pdfName: "Czech Republic", dbName: "Czech Republic",
    GK:  ["Matej Kovar", "Lukas Hornicek", "Jindrich Stanek"],
    DEF: ["Ladislav Krejci", "Robin Hranac", "Vladimir Coufal", "Stepan Chaloupek", "David Jurasek", "Tomas Holes", "Jaroslav Zeleny", "David Doudera", "David Zima"],
    MID: ["Tomas Soucek", "Vladimir Darida", "Lukas Provod", "Pavel Sulc", "Michal Sadilek", "Lukas Cerv", "Alexandr Sojka", "Denis Visinsky", "Hugo Sochurek"],
    FWD: ["Patrik Schick", "Tomas Chory", "Mojmir Chytil", "Adam Hlozek", "Jan Kuchta/GTD"],
  },
  {
    pdfName: "Congo DR", dbName: "Congo DR",
    GK:  ["Lionel Mpasi", "Timothy Fayulu", "Matthieu Epolo"],
    DEF: ["Aaron Wan-Bissaka", "Axel Tuanzebe", "Chancel Mbemba", "Arthur Masuaku", "Joris Kayembe", "Dylan Batubinsika", "Gedeon Kalulu", "Steve Kapuadi"],
    MID: ["Noah Sadiki", "Samuel Moutoussamy", "Nathanael Mbuku", "Meschack Elia", "Ngal'ayel Mukau", "Charles Pickel", "Edo Kayembe", "Brian Cipenga", "Gael Kakuta", "Theo Bongonda", "Aaron Tshibola"],
    FWD: ["Cedric Bakambu", "Yoane Wissa", "Simon Banza", "Fiston Mayele"],
  },
  {
    pdfName: "Ecuador", dbName: "Ecuador",
    GK:  ["Hernan Ismael Galindez", "Gonzalo Roberto Valle Bustamante", "Wellington Moises Ramirez Preciado"],
    DEF: ["Willian Pacho", "Piero Hincapie", "Pervis Estupinan", "Joel Ordonez", "Felix Torres", "Angelo Preciado", "Jackson Porozo", "Yaimar Medina"],
    MID: ["Moises Caicedo", "Pedro Vite", "Alan Franco", "Nilson Angulo", "John Yeboah", "Alan Minda", "Kendry Paez", "Denil Castillo"],
    FWD: ["Enner Valencia", "Gonzalo Plata", "Kevin Rodriguez", "Jordy Caicedo", "Jordy Alcivar", "Anthony Lenin Valencia Bajana", "Jeremy Arevalo"],
  },
  {
    pdfName: "Ghana", dbName: "Ghana",
    GK:  ["Benjamin Asare", "Lawrence Ati-Zigi", "Joseph Anang"],
    DEF: ["Kojo Peprah Oppong", "Jonas Adjetey", "Jerome Opoku/GTD", "Gideon Mensah", "Abdul-Rahman Baba", "Marvin Senaya", "Alidu Seidu", "Abdul Mumin", "Derrick Luckassen"],
    MID: ["Thomas Partey", "Caleb Yirenkyi", "Kwasi Sibo", "Elisha Owusu", "Kamaldeen Sulemana", "Abdul Fatawu", "Augustine Boakye"],
    FWD: ["Jordan Ayew", "Inaki Williams", "Antoine Semenyo", "Prince Adu", "Christopher Bonsu Baah", "Ernest Nuamah", "Brandon Thomas-Asante"],
  },
  {
    pdfName: "Iraq", dbName: "Iraq",
    GK:  ["Jalal Hassan", "Ahmed Basil", "Fahad Talib Raheem"],
    DEF: ["Merchas Doski", "Zaid Tahseen", "Hussein Ali", "Rebin Sulaka", "Akam Hashem", "Munaf Younus Hashim Al Tekreeti", "Frans Dhia Jirjis Haddad", "Mustafa Sadoun", "Ahmed Maknzi"],
    MID: ["Amir Al-Ammari", "Ibrahim Bayesh", "Youssef Amyn", "Zidane Aamar Iqbal", "Aimar Sher", "Marko Hussein Farji", "Kevin Enkido Yakob", "Ahmed Qasem", "Zaid Ismael Khaleel Al Dulaimi"],
    FWD: ["Aymen Hussein", "Ali Al Hamadi", "Ali Jasim", "Mohanad Ali Kadhim Al Shammari", "Ali Yousif Hashim Najatee"],
  },
  {
    pdfName: "Cote D'ivoire", dbName: "Ivory Coast",
    GK:  ["Yahia Fofana", "Alban Lafont", "Mohamed Kone"],
    DEF: ["Ghislain Konan", "Guela Doue", "Odilon Kossounou/GTD", "Evan N'Dicka/OUT", "Emmanuel Agbadou", "Ousmane Diomande", "Wilfried Singo", "Christopher Operi"],
    MID: ["Franck Kessie", "Ibrahim Sangare", "Seko Fofana", "Christ Inao Oulai", "Jean Michael Seri", "Parfait Guiagon", "Oumar Diakite"],
    FWD: ["Amad Diallo", "Yan Diomande", "Evann Guessand", "Nicolas Pepe", "Bazoumana Toure", "Simon Adingra", "Ange-Yoan Bonny", "Elye Wahi"],
  },
  {
    pdfName: "Netherlands", dbName: "Netherlands",
    GK:  ["Bart Verbruggen", "Mark Flekken", "Robin Roefs"],
    DEF: ["Virgil van Dijk", "Micky van de Ven", "Denzel Dumfries", "Jurrien Timber", "Nathan Ake", "Jan Paul van Hecke", "Jorrel Hato", "Mats Wieffer"],
    MID: ["Frenkie de Jong", "Ryan Gravenberch", "Tijjani Reijnders", "Teun Koopmeiners", "Quinten Timber", "Guus Til", "Marten De Roon"],
    FWD: ["Cody Gakpo", "Donyell Malen", "Memphis Depay", "Wout Weghorst", "Brian Brobbey", "Justin Kluivert", "Noa Lang", "Crysencio Summerville"],
  },
  {
    pdfName: "New Zealand", dbName: "New Zealand",
    GK:  ["Maxime Teremoana Crocombe", "Alexander Paulsen", "Michael Cornelis Woud"],
    DEF: ["Tyler Bindon", "Michael Boxall", "Benjamin Old", "Liberato Cacace", "Tim Payne", "Finn Surman", "Francis de Vries", "Callan Elliot", "Nando Zen Pijnaker", "Tommy Smith"],
    MID: ["Marko Stamenic", "Elijah Just", "Joe Bell", "Sarpreet Singh", "Matthew Garbett", "Jesse Randall", "Ryan Thomas", "Lachlan Bayliss", "Alex Arthur Rufer"],
    FWD: ["Chris Wood", "Ben Waine", "Callum McCowatt", "Kosta Barbarouses"],
  },
  {
    pdfName: "Norway", dbName: "Norway",
    GK:  ["Orjan Nyland", "Egil Selvik", "Sander Tangvik"],
    DEF: ["Kristoffer Ajer", "Julian Ryerson", "David Moller Wolfe", "Torbjorn Heggem", "Leo Ostigard", "Fredrik Andre Bjorkan", "Marcus Pedersen", "Sondre Langas", "Henrik Falchener"],
    MID: ["Martin Odegaard", "Sander Berge", "Patrick Berg", "Morten Thorsby", "Kristian Thorstvedt", "Andreas Schjelderup", "Oscar Bobb", "Jens Petter Hauge", "Thelo Aasgaard", "Fredrik Aursnes"],
    FWD: ["Erling Haaland", "Alexander Sorloth", "Antonio Nusa", "Jorgen Strand Larsen"],
  },
  {
    pdfName: "Paraguay", dbName: "Paraguay",
    GK:  ["Gatito Fernandez", "Orlando Gill", "Gaston Hernan Olveira Echeverria"],
    DEF: ["Gustavo Gomez", "Omar Alderete", "Juan Jose Caceres", "Junior Alonso", "Fabian Balbuena", "Victor Gustavo Velazquez", "Jose Canale", "Alexandro Maidana"],
    MID: ["Miguel Almiron", "Diego Gomez", "Julio Enciso/OUT", "Andres Cubas", "Damian Bobadilla/GTD", "Ramon Sosa", "Mauricio", "Braian Ojeda", "Matias Galarza", "Kaku"],
    FWD: ["Antonio Sanabria", "Gabriel Avalos", "Alex Arce", "Gustavo Caballero", "Isidro Pitta"],
  },
  {
    pdfName: "Qatar", dbName: "Qatar",
    GK:  ["Meshaal Barsham", "Salah Zakaria", "Mahmud Ibrahim Abunada"],
    DEF: ["Pedro Miguel", "Boualem Khoukhi", "Lucas Michel Mendes", "Sultan Al Brake", "Homam Ahmed", "Gueye Seydinaissa Laye", "Al Hashmi Al Hussain Mohi Aldin", "Ayoub Al Oui"],
    MID: ["Karim Boudiaf", "Assim Madibo", "Mohammad Naceur Al Mannai", "Ahmed Fathy", "Abdulaziz Hatem", "Jassem Gaber"],
    FWD: ["Akram Afif", "Almoez Ali", "Edmilson Junior", "Hassan Al-Haydos", "Yusuf Abdurisag", "Ahmed Mohammed Hussein Kassim Al Ganehi", "Mohammed Muntari", "Ahmed Alaa Eldin", "Tahsin Jamshid"],
  },
  {
    pdfName: "Scotland", dbName: "Scotland",
    GK:  ["Angus Gunn", "Liam Kelly", "Craig Gordon"],
    DEF: ["Andrew Robertson", "John Souttar", "Aaron Hickey", "Scott McKenna", "Grant Hanley", "Anthony Ralston", "Kieran Tierney", "Jack Hendry", "Nathan Patterson", "Dominic Hyam"],
    MID: ["Scott McTominay", "John McGinn", "Ryan Christie", "Ben Gannon Doak", "Kenny McLean", "Lewis Ferguson", "Findlay Curtis", "Tyler Robert Fletcher"],
    FWD: ["Che Adams", "Lyndon Dykes", "George Hirst", "Lawrence Shankland", "Ross Stewart"],
  },
  {
    pdfName: "South Africa", dbName: "South Africa",
    GK:  ["Ronwen Hayden Williams", "Ricardo Goss", "Sipho Chaine"],
    DEF: ["Ime Okon", "Mbekezeli Mbokazi", "Khuliso Mudau", "Aubrey Modiba/GTD", "Khulumani Ndamane", "Thabang Matuludi", "Samukele Kabini", "Olwethu Makhanya", "Bradley Cross", "Kamogelo Sebelebele", "Nkosinathi Sibisi"],
    MID: ["Teboho Mokoena", "Thalente Mbatha", "Sphephelo Sithole", "Jayden Adams"],
    FWD: ["Lyle Foster", "Oswin Appollis", "Relebohile Mofokeng", "Tshepang Moremi", "Evidence Makgopa", "Themba Zwane", "Thapelo Maseko", "Iqraam Rayners"],
  },
  {
    pdfName: "USA", dbName: "USA",
    GK:  ["Matt Turner", "Matt Freese", "Chris Brady"],
    DEF: ["Chris Richards/GTD", "Antonee Robinson", "Tim Ream", "Mark McKenzie", "Sergino Dest", "Miles Robinson", "Auston Trusty", "Alex Freeman", "Joe Scally", "Max Arfsten"],
    MID: ["Tyler Adams", "Weston McKennie", "Malik Tillman", "Giovanni Reyna", "Cristian Roldan", "Sebastian Berhalter"],
    FWD: ["Christian Pulisic", "Folarin Balogun", "Timothy Weah", "Brenden Aaronson", "Ricardo Pepi", "Haji Wright", "Alejandro Zendejas"],
  },
  {
    pdfName: "Uzbekistan", dbName: "Uzbekistan",
    GK:  ["Utkir Yusupov", "Abduvohid Ne'matov", "Botirali Ergashev"],
    DEF: ["Abdukodir Khusanov", "Rustamjon Ashurmatov", "Abdulla Abdullaev", "Sherzod Nasrullayev", "Khojiakbar Alijonov/GTD", "Umarbek Eshmurodov", "Farruh Sayfiyev", "Avazbek O'lmasaliev", "Jakhongir Urozov", "Bekhruz Karimov"],
    MID: ["Otabek Shukurov", "Abbosbek Fayzullaev", "Odiljon Hamrobekov", "Jamshid Iskanderov", "Aziz Ganiyev/GTD", "Akmal Mozgovoy", "Jaloliddin Masharipov", "Sherzod Esanov"],
    FWD: ["Eldor Shomurodov", "Oston Urunov", "Igor Sergeyev", "Dostonbek Khamdamov", "Azizbek Amanov"],
  },
  {
    pdfName: "Canada", dbName: "Canada",
    GK:  ["Maxime Crepeau", "Dayne St. Clair", "Owen Goodman"],
    DEF: ["Alphonso Davies/GTD", "Derek Cornelius", "Moise Bombito/GTD", "Alistair Johnston", "Richie Laryea", "Niko Sigur", "Joel Waterman", "Luc De Fougerolles", "Alfie Jones/GTD"],
    MID: ["Tajon Buchanan", "Ismael Kone", "Stephen Eustaquio", "Ali Ahmed/GTD", "Liam Millar", "Nathan Saliba", "Jonathan Osorio", "Mathieu Choiniere", "Jacob Shaffelburg/GTD"],
    FWD: ["Jonathan David", "Cyle Larin", "Promise David", "Tani Oluwaseyi"],
  },
  {
    pdfName: "Curacao", dbName: "Curaçao",
    GK:  ["Eloy Room", "Tyrick Bodak", "Trevor Doornbusch"],
    DEF: ["Jurien Gaari", "Armando Obispo", "Sherel Floranus", "Shurandy Sambo", "Roshon van Eijma", "Joshua Brenet", "Livano Comenencia", "Deveron Fonville"],
    MID: ["Leandro Bacuna", "Juninho Bacuna", "Livano Comenencia", "Kevin Felida", "Ar'jany Martha", "Tyrese Noslin", "Godfried Roemeratoe"],
    FWD: ["Jeremy Antonisse", "Gervane Kastaneer", "Tahith Chong", "Kenji Gorre", "Brandley Kuwas", "Jurgen Locadia", "Sontje Hansen", "Jearl Margaritha"],
  },
  {
    pdfName: "Haiti", dbName: "Haiti",
    GK:  ["Johnny Placide", "Alexandre Pierre", "Josue Duverger"],
    DEF: ["Ricardo Ade", "Hannes Delcroix", "Duke Lacroix", "Carlens Arcus", "Jean-Kevin Duverne", "Martin Experience", "Wilguens Paugain", "Keeto Thermoncy"],
    MID: ["Leverton Pierre", "Jean-Ricner Bellegarde", "Josue Casimir", "Ruben Providence", "Louicius Deedson", "Danley Jean Jacques", "Carl Sainte", "Woodensky Pierre", "Dominique Simon"],
    FWD: ["Wilson Isidor", "Duckens Nazon", "Frantzdy Pierrot", "Yassin Fortune", "Derrick Etienne", "Lenny Joseph"],
  },
  {
    pdfName: "Turkey", dbName: "Türkiye",
    GK:  ["Ugurcan Cakir", "Fehmi Mert Gunok", "Altay Bayindir"],
    DEF: ["Abdulkerim Bardakci", "Ferdi Kadioglu/GTD", "Merih Demiral", "Zeki Celik", "Ozan Kabak", "Caglar Soyuncu", "Mert Muldur", "Samet Akaydin", "Eren Elmali"],
    MID: ["Hakan Calhanoglu/GTD", "Arda Guler", "Ismail Yuksek", "Baris Yilmaz", "Orkun Kokcu", "Salih Ozcan", "Can Uzun", "Kaan Ayhan"],
    FWD: ["Kerem Akturkoglu", "Kenan Yildiz/GTD", "Irfan Can Kahveci", "Deniz Gul", "Oguz Aydin", "Yunus Akgun"],
  },
  {
    pdfName: "Jordan", dbName: "Jordan",
    GK:  ["Yazeed Mo'ien Hasan Abulaila", "Noureddin Zaid Khaleel Bani Ateyah", "Abdallah Al Fakhouri"],
    DEF: ["Husam Ali Mohammad Abu Dahab", "Yazan Al-Arab", "Mohannad Abu Taha", "Ehsan Haddad", "Abdallah Mousa Musallam Nasib", "Mohammad Ali Hasan Abu Hashish", "Saleem Amer Saleem Obaid", "Saed Ahmad Salameh Al Rosan", "Mohammad Abualnadi", "Anas Badawi"],
    MID: ["Nizar Mahmoud Ahmed Al Rashdan", "Noor Al Rawabdeh", "Mahmoud Al Mardi", "Amer Rasem Adel Jamous", "Ibrahim Mohammad Sami Sadeh", "Rajaei Ayed", "Mohammad Al Daoud", "Mohammad Abu Ghosh"],
    FWD: ["Mousa Tamari", "Ali Olwan", "Mohammad Abu Zraiq", "Odeh Burhan Shehade Fakhoury", "Ali Azaizeh"],
  },
];

// ── Flatten NATIONS into DepthEntry array ────────────────────────────────────
type Tag = "GTD" | "OUT" | null;
type DepthEntry = {
  dbNationName: string;
  pos: FantasyPosition;
  rank: number;
  rawName: string;
  tag: Tag;
};

function parseTag(s: string): { name: string; tag: Tag } {
  if (s.endsWith("/GTD")) return { name: s.slice(0, -4), tag: "GTD" };
  if (s.endsWith("/OUT")) return { name: s.slice(0, -4), tag: "OUT" };
  return { name: s, tag: null };
}

function flattenNations(): DepthEntry[] {
  const entries: DepthEntry[] = [];
  for (const n of NATIONS) {
    const posGroups: [FantasyPosition, string[]][] = [
      ["GK", n.GK], ["DEF", n.DEF], ["MID", n.MID], ["FWD", n.FWD],
    ];
    for (const [pos, players] of posGroups) {
      for (let i = 0; i < players.length; i++) {
        const { name, tag } = parseTag(players[i]);
        entries.push({ dbNationName: n.dbName, pos, rank: i + 1, rawName: name, tag });
      }
    }
  }
  return entries;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const entries = flattenNations();
  console.log(`Depth chart entries parsed: ${entries.length}`);

  // ── Sanity check: per-nation totals ────────────────────────────────────────
  const flagged: string[] = [];
  for (const n of NATIONS) {
    const total = n.GK.length + n.DEF.length + n.MID.length + n.FWD.length;
    if (total < 23 || total > 26) flagged.push(`${n.pdfName}: ${total} (expected 23-26)`);
  }
  if (flagged.length > 0) {
    console.warn(`\nFLAGGED nations (off squad count):`);
    flagged.forEach((f) => console.warn(`  ${f}`));
  } else {
    console.log(`All 48 nations within 23-26 range.`);
  }

  // ── Load DB nations → name → id ────────────────────────────────────────────
  const allNations = await db.select({ id: nationsTable.id, name: nationsTable.name }).from(nationsTable);
  const nationByName = new Map(allNations.map((n) => [n.name, n.id]));

  const missingNations: string[] = [];
  for (const n of NATIONS) {
    if (!nationByName.has(n.dbName)) missingNations.push(`"${n.pdfName}" → "${n.dbName}"`);
  }
  if (missingNations.length > 0) {
    console.error("STOP: DB missing nations:", missingNations);
    await client.end();
    process.exit(1);
  }

  // ── Load DB players grouped by nation ─────────────────────────────────────
  const dbPlayers = await db
    .select({ id: playersTable.id, name: playersTable.name, nationId: playersTable.nationId, position: playersTable.position })
    .from(playersTable);

  const playersByNation = new Map<string, DbPlayer[]>();
  for (const p of dbPlayers) {
    if (!playersByNation.has(p.nationId)) playersByNation.set(p.nationId, []);
    playersByNation.get(p.nationId)!.push(p);
  }

  // ── Load status_overridden set ─────────────────────────────────────────────
  const existingRankings = await db
    .select({ playerId: playerRankingsTable.playerId, statusOverridden: playerRankingsTable.statusOverridden })
    .from(playerRankingsTable);
  const statusOverriddenSet = new Set(
    existingRankings.filter((r) => r.statusOverridden).map((r) => r.playerId)
  );

  // ── Match entries → player_id ───────────────────────────────────────────────
  interface Matched {
    playerId: string;
    dbName: string;
    rawName: string;
    playStatus: PlayStatus;
    step: string;
    nationName: string;
    pos: FantasyPosition;
    rank: number;
    tag: Tag;
  }
  interface Rejected {
    nationName: string;
    pos: FantasyPosition;
    rank: number;
    rawName: string;
    tag: Tag;
    reason: string;
    candidates: string[];
  }

  const matched: Matched[] = [];
  const rejected: Rejected[] = [];
  const collisionCheck = new Map<string, Matched[]>();

  for (const entry of entries) {
    const nationId = nationByName.get(entry.dbNationName)!;
    const nationPlayers = playersByNation.get(nationId) ?? [];

    const result = matchPlayerByName(entry.rawName, [entry.pos], nationPlayers);

    if (result?.kind === "match") {
      const m: Matched = {
        playerId: result.player.id,
        dbName: result.player.name,
        rawName: entry.rawName,
        playStatus: rankToStatus(entry.rank, entry.tag),
        step: result.step,
        nationName: entry.dbNationName,
        pos: entry.pos,
        rank: entry.rank,
        tag: entry.tag,
      };
      matched.push(m);
      const list = collisionCheck.get(m.playerId) ?? [];
      list.push(m);
      collisionCheck.set(m.playerId, list);
      continue;
    }

    // Override map
    const overrideKey = `${entry.dbNationName}:${entry.rawName}`;
    const overrideName = NAME_OVERRIDES[overrideKey];
    if (overrideName !== undefined) {
      const target = nationPlayers.find(
        (p) => normalizeName(p.name) === normalizeName(overrideName)
      );
      if (target) {
        const m: Matched = {
          playerId: target.id,
          dbName: target.name,
          rawName: entry.rawName,
          playStatus: rankToStatus(entry.rank, entry.tag),
          step: "override",
          nationName: entry.dbNationName,
          pos: entry.pos,
          rank: entry.rank,
          tag: entry.tag,
        };
        matched.push(m);
        const list = collisionCheck.get(m.playerId) ?? [];
        list.push(m);
        collisionCheck.set(m.playerId, list);
        continue;
      }
      console.warn(`  ⚠ override target not found: "${overrideKey}" → "${overrideName}"`);
    }

    rejected.push({
      nationName: entry.dbNationName,
      pos: entry.pos,
      rank: entry.rank,
      rawName: entry.rawName,
      tag: entry.tag,
      reason: result?.kind === "ambiguous" ? result.reason : "no match",
      candidates: result?.kind === "ambiguous" ? result.candidates : [],
    });
  }

  // Collision report
  const collisions = [...collisionCheck.entries()].filter(([, ms]) => ms.length > 1);
  if (collisions.length > 0) {
    console.warn(`\n⚠ COLLISIONS (${collisions.length} players matched by multiple entries):`);
    for (const [, ms] of collisions) {
      console.warn(`  DB "${ms[0].dbName}" (${ms[0].nationName}):`);
      for (const m of ms) console.warn(`    - rank ${m.rank} ${m.pos} "${m.rawName}" tag=${m.tag ?? "none"}`);
    }
  }

  // Deduplicate: for a given player_id, last write wins (consistent with sequential upsert).
  // In practice collisions here are same player listed in two pos groups (e.g. Brazil Ederson/Danilo).
  const matchedForWrite = [...new Map(matched.map((m) => [m.playerId, m])).values()];

  // ── Write play_status to player_rankings ───────────────────────────────────
  console.log("\nWriting play_status to player_rankings...");

  const toWrite = matchedForWrite.filter((m) => !statusOverriddenSet.has(m.playerId));
  const skipped = matchedForWrite.length - toWrite.length;

  for (const chunk of chunkArray(toWrite, 200)) {
    await db
      .insert(playerRankingsTable)
      .values(chunk.map((m) => ({ playerId: m.playerId, playStatus: m.playStatus })))
      .onConflictDoUpdate({
        target: playerRankingsTable.playerId,
        set: {
          playStatus: sql`excluded.play_status`,
          updatedAt: sql`now()`,
        },
      });
  }

  console.log(`Wrote ${toWrite.length} rows (skipped ${skipped} status_overridden).`);

  // ── Report ─────────────────────────────────────────────────────────────────
  const statusCounts: Record<PlayStatus, number> = {
    definite_starter: 0,
    probable_starter: 0,
    possible_starter: 0,
    probable_substitute: 0,
    possible_substitute: 0,
    wont_play_much: 0,
  };
  for (const m of toWrite) statusCounts[m.playStatus]++;

  console.log("\n════════════════════════════════════════");
  console.log("DEPTH CHART INGEST REPORT");
  console.log("════════════════════════════════════════");
  console.log(`Entries parsed:      ${entries.length}`);
  console.log(`Matched:             ${matched.length} / ${entries.length}`);
  console.log(`  rule-based:        ${matched.filter((m) => m.step !== "override").length}`);
  console.log(`  overrides:         ${matched.filter((m) => m.step === "override").length}`);
  console.log(`Rejected:            ${rejected.length}`);
  console.log(`Collisions:          ${collisions.length}`);
  console.log(`DB rows written:     ${toWrite.length} (${skipped} skipped / status_overridden)`);

  console.log("\nPlay-status counts (written rows):");
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`  ${status.padEnd(22)} ${count}`);
  }
  console.log(`\n  Sanity: ~${48 * 4} definite_starters expected (1 per pos group per nation)`);

  console.log(`\nCutoff mapping:`);
  console.log(`  rank 1         → definite_starter`);
  console.log(`  rank 2         → probable_starter`);
  console.log(`  rank 3         → possible_starter`);
  console.log(`  rank 4         → probable_substitute`);
  console.log(`  rank 5         → possible_substitute`);
  console.log(`  rank 6+        → wont_play_much`);
  console.log(`  GTD modifier   → downgrade 1 level, floor at possible_starter`);
  console.log(`  OUT override   → wont_play_much`);

  if (rejected.length > 0) {
    console.log(`\nRejected entries (${rejected.length}):`);
    for (const r of rejected) {
      const tagStr = r.tag ? ` [${r.tag}]` : "";
      const candStr = r.candidates.length > 0 ? ` → [${r.candidates.join(" | ")}]` : "";
      console.log(`  ${r.nationName} | ${r.pos} #${r.rank} | ${r.rawName}${tagStr} | ${r.reason}${candStr}`);
    }
  }
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error(err); await client.end(); process.exit(1); });
